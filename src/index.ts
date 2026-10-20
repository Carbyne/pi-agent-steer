/**
 * pi-agent-steer — fork of @agnishc/edb-agent-steer (MIT, Agnish Chakraborty).
 *
 * When the user submits a message while the agent is already running, a
 * compact inline prompt shows five single-key options:
 *
 *   s  steer          — deliver before the next LLM call (pi core steer queue)
 *   q  queue          — deliver after the agent fully finishes
 *   a  queue idle-only — deliver only when the agent is idle AND no
 *                        background jobs are running (pi-bg-jobs aware)
 *   d  discard        — throw the message away
 *   e  edit           — restore the text to the editor (also: Esc)
 *
 * Key difference vs upstream edb-agent-steer: q/a queueing is EXTENSION-owned.
 * Messages never enter pi's built-in steering/follow-up queue, so the core
 * "↳ Alt+Up to edit all queued messages" UI never appears — that binding is
 * broken on VSCode remote terminals on Windows. Recall queued text with
 * /unqueue instead (it lands back in the editor, editable).
 *
 * Compaction-safe: pi refuses sendUserMessage while compaction runs; during
 * compaction this extension never offers "steer" and never calls
 * sendUserMessage — everything is parked in the extension queue and drained
 * when the session settles.
 *
 * /steer <text> still uses pi's native steer (that is the point), with a
 * compaction fallback into the extension queue.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SteerPromptComponent } from "./component.ts";
import type { QueuedMessage, SteerChoice } from "./types.ts";

const STATUS_KEY = "agent-steer";
const BG_STATUS_EVENT = "bg-jobs:status";
const BG_STATUS_REQUEST = "bg-jobs:status-request";

// ── Extension ──────────────────────────────────────────────────────────────────

export default function steerExtension(pi: ExtensionAPI): void {
    const queue: QueuedMessage[] = [];
    let bgRunning = 0;
    let compacting = false;
    let lastCtx: ExtensionContext | undefined;
    let flushTimer: NodeJS.Timeout | undefined;

    const isCompactionError = (err: unknown): boolean => /compact/i.test(String(err));

    function updateStatus(): void {
        try {
            if (!lastCtx?.hasUI) return;
            if (queue.length === 0) {
                lastCtx.ui.setStatus(STATUS_KEY, undefined);
                return;
            }
            const waitIdle = queue.some((m) => m.mode === "waitidle" && bgRunning > 0);
            lastCtx.ui.setStatus(
                STATUS_KEY,
                `⏳ ${queue.length} queued${waitIdle ? " (waiting for bg jobs)" : ""} — /unqueue`
            );
        } catch {
            /* stale ctx */
        }
    }

    function armFlush(delayMs = 400): void {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(() => {
            flushTimer = undefined;
            flushOnce();
        }, delayMs);
        flushTimer.unref();
    }

    /** Deliver the next deliverable queued message. One per idle transition. */
    function flushOnce(): void {
        if (queue.length === 0) {
            updateStatus();
            return;
        }
        if (!lastCtx) return;
        if (compacting) {
            armFlush(1000);
            return;
        }
        let ctxIdle = false;
        try {
            ctxIdle = lastCtx.isIdle();
        } catch {
            return;
        }
        if (!ctxIdle) return; // agent_settled / status events re-arm us
        const idx = queue.findIndex(
            (m) => m.mode === "queue" || (m.mode === "waitidle" && bgRunning === 0)
        );
        if (idx === -1) {
            updateStatus();
            return;
        }
        const [msg] = queue.splice(idx, 1);
        try {
            // Idle delivery triggers a fresh turn — and crucially never enters
            // pi's queue widget (no "Follow-up:" line, no Alt+Up hint).
            pi.sendUserMessage(msg.text);
        } catch (err) {
            if (isCompactionError(err)) {
                compacting = true;
                queue.unshift(msg);
                armFlush(1000);
                return;
            }
            try {
                lastCtx.ui.notify(`agent-steer: failed to deliver queued message: ${String(err)}`, "error");
            } catch {
                /* stale ctx */
            }
        }
        updateStatus();
        if (queue.length > 0) armFlush(800);
    }

    // ── bg-jobs awareness ─────────────────────────────────────────────────────
    try {
        pi.events.on(BG_STATUS_EVENT, (s: unknown) => {
            const status = s as { running?: number } | undefined;
            bgRunning = typeof status?.running === "number" ? status.running : 0;
            updateStatus();
            if (bgRunning === 0 && queue.some((m) => m.mode === "waitidle")) armFlush(300);
        });
    } catch {
        /* event bus unavailable */
    }

    // ── lifecycle events ──────────────────────────────────────────────────────
    pi.on("session_start", async (_event, ctx) => {
        lastCtx = ctx;
        compacting = false;
        // Fresh snapshot in case jobs finished while we weren't listening.
        try {
            pi.events.emit(BG_STATUS_REQUEST, undefined);
        } catch {
            /* ignore */
        }
        if (queue.length > 0) updateStatus();
    });

    pi.on("agent_start", async (_event, ctx) => {
        lastCtx = ctx;
    });

    pi.on("agent_settled", async (_event, ctx) => {
        lastCtx = ctx;
        if (queue.length > 0) armFlush(250);
    });

    pi.on("session_before_compact", async () => {
        compacting = true;
        return undefined;
    });
    pi.on("session_compact", async () => {
        compacting = false;
        if (queue.length > 0) armFlush(250);
    });
    pi.on("session_compact_failed", async () => {
        compacting = false;
        if (queue.length > 0) armFlush(250);
    });

    // ── Input interceptor ─────────────────────────────────────────────────────
    pi.on("input", async (event, ctx) => {
        // Only intercept typed messages, not extension-injected ones.
        if (event.source !== "interactive") return { action: "continue" };

        // Don't intercept empty input — Esc in the editor fires input with
        // event.text === "" and we must not block that.
        if (!event.text?.trim()) return { action: "continue" };

        lastCtx = ctx;

        // Agent idle and not compacting — pass through normally (no prompt).
        if (ctx.isIdle() && !compacting) return { action: "continue" };

        // No interactive UI (print / JSON mode) — pass through.
        if (!ctx.hasUI) return { action: "continue" };

        // Show the single-keypress prompt (steer stays selectable: while
        // compacting it is internally downgraded to queue, never an error).
        const choice = await ctx.ui.custom<SteerChoice>(
            (_tui, theme, _kb, done) =>
                new SteerPromptComponent(event.text, theme, done, { compacting, bgRunning }),
        );

        // edit / Esc / unexpected null → restore text to editor, do nothing else.
        if (!choice || choice === "edit") {
            ctx.ui.setEditorText(event.text);
            return { action: "handled" };
        }

        if (choice === "discard") {
            ctx.ui.notify("Message discarded", "info");
            return { action: "handled" };
        }

        if (choice === "steer" && !compacting) {
            try {
                pi.sendUserMessage(event.text, { deliverAs: "steer" });
                ctx.ui.notify("◀ Steered — before the next LLM call", "info");
            } catch (err) {
                if (isCompactionError(err)) {
                    compacting = true;
                    queue.push({ text: event.text, mode: "queue", queuedAt: Date.now() });
                    updateStatus();
                    armFlush(1000);
                    ctx.ui.notify("Compaction started mid-steer — message queued instead (/unqueue to edit)", "warning");
                } else {
                    ctx.ui.notify(`agent-steer: steer failed: ${String(err)}`, "error");
                }
            }
            return { action: "handled" };
        }

        // Extension-owned queue (queue, waitidle, or steer-during-compaction).
        queue.push({
            text: event.text,
            mode: choice === "waitidle" ? "waitidle" : "queue",
            queuedAt: Date.now(),
        });
        updateStatus();
        ctx.ui.notify(
            choice === "waitidle"
                ? "⏳ Queued until fully idle (no agent turn, no background jobs) — /unqueue to edit"
                : compacting && choice === "steer"
                  ? "⏳ Compacting — steer downgraded to queue; delivered when settled (/unqueue to edit)"
                  : "⏳ Queued — delivered when the agent finishes (/unqueue to edit)",
            "info"
        );
        armFlush(600);
        return { action: "handled" };
    });

    // ── /unqueue — the Alt+Up replacement ─────────────────────────────────────
    pi.registerCommand("unqueue", {
        description:
            "agent-steer: pull all extension-queued messages back into the editor (works where Alt+Up doesn't)",
        handler: async (_args, ctx) => {
            lastCtx = ctx;
            if (queue.length === 0) {
                ctx.ui.notify("agent-steer: nothing queued", "info");
                return;
            }
            const text = queue.map((m) => m.text).join("\n\n");
            const n = queue.length;
            queue.length = 0;
            updateStatus();
            ctx.ui.setEditorText(text);
            ctx.ui.notify(`↩ Restored ${n} queued message(s) to the editor`, "info");
        },
    });

    // ── /steer slash command — explicit steer, bypasses the prompt ────────────
    pi.registerCommand("steer", {
        description: "Steer a message directly into the running agent turn. Usage: /steer <text>",
        handler: async (args, ctx) => {
            lastCtx = ctx;
            const content = args?.trim();
            if (!content) {
                ctx.ui.notify("/steer <text>  — steer text before the next LLM call", "info");
                return;
            }
            const running = !ctx.isIdle();
            if (running && !compacting) {
                try {
                    pi.sendUserMessage(content, { deliverAs: "steer" });
                    ctx.ui.notify("◀ Steered — before the next LLM call", "info");
                    return;
                } catch (err) {
                    if (isCompactionError(err)) {
                        compacting = true;
                    } else {
                        ctx.ui.notify(`agent-steer: steer failed: ${String(err)}`, "error");
                        return;
                    }
                }
            }
            if (running || compacting) {
                queue.push({ text: content, mode: "queue", queuedAt: Date.now() });
                updateStatus();
                armFlush(600);
                ctx.ui.notify("⏳ Queued (busy/compacting) — delivered when settled", "info");
                return;
            }
            pi.sendUserMessage(content);
            ctx.ui.notify("◀ Steered — triggering response", "info");
        },
    });
}
