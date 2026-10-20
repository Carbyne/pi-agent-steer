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
 * Ordering vs bg-jobs notices: waitidle deliveries hold for a grace window
 * ("agentSteer".jobDoneGrace, default 1s) after bg jobs drain. bg-jobs flips
 * its status event immediately on job completion but emits the actual
 * completion notice (job output) after a coalescing delay — without the hold,
 * queued prompts would jump ahead of the notice and the agent would answer
 * without ever having seen the job result. If the notice wakes the agent,
 * delivery additionally waits for the next settle.
 *
 * /steer <text> still uses pi's native steer (that is the point), with a
 * compaction fallback into the extension queue. Slash commands also expose the
 * queue choices directly: /queue <text> (deliver when the agent finishes) and
 * /idlequeue <text> (deliver only when the agent AND all background jobs are
 * idle) — both bypass the inline prompt, like /steer.
 *
 * Setting "agentSteer": { "promptWhenIdleWithBg": true } additionally shows
 * the same prompt when the AGENT IS IDLE BUT BACKGROUND JOBS ARE RUNNING
 * (normally such input starts a turn immediately). In that state s/q send now
 * and a holds delivery until the jobs drain.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SteerPromptComponent } from "./component.ts";
import type { QueuedMessage, SteerChoice } from "./types.ts";

const STATUS_KEY = "agent-steer";
const BG_STATUS_EVENT = "bg-jobs:status";
const BG_STATUS_REQUEST = "bg-jobs:status-request";

interface SteerCfg {
    /** Show the steer/queue prompt when the agent is idle but bg jobs run.
     *  ON by default — this is the whole point of the extension; disable
     *  with "agentSteer": { "promptWhenIdleWithBg": false }. */
    promptWhenIdleWithBg: boolean;
    /** Hold waitidle deliveries this long after bg jobs drain, so bg-jobs'
     *  own completion notice (coalesced ~coalesceMs after the status flip)
     *  reaches the agent FIRST. Same reasoning as ralph-loop's --job-grace. */
    jobDoneGraceMs: number;
}

function parseDur(v: unknown): number | undefined {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v * 1000);
    if (typeof v === "string") {
        const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
        if (m) {
            const n = Number(m[1]);
            const mul = ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[
                (m[2] ?? "s").toLowerCase() as "ms" | "s" | "m" | "h"
            ];
            return Math.floor(n * mul);
        }
    }
    return undefined;
}

function loadSteerSettings(cwd: string): SteerCfg {
    const cfg: SteerCfg = { promptWhenIdleWithBg: true, jobDoneGraceMs: 1000 };
    const read = (p: string): Record<string, unknown> => {
        try {
            return JSON.parse(readFileSync(p, "utf8"));
        } catch {
            return {};
        }
    };
    const merged = {
        ...read(join(getAgentDir(), "settings.json")),
        ...read(join(cwd, CONFIG_DIR_NAME, "settings.json")),
    };
    const s = (merged.agentSteer ?? {}) as Record<string, unknown>;
    if (typeof s.promptWhenIdleWithBg === "boolean") cfg.promptWhenIdleWithBg = s.promptWhenIdleWithBg;
    const grace = parseDur(s.jobDoneGrace);
    if (grace !== undefined) cfg.jobDoneGraceMs = grace;
    return cfg;
}

// ── Extension ──────────────────────────────────────────────────────────────────

export default function steerExtension(pi: ExtensionAPI): void {
    const queue: QueuedMessage[] = [];
    let bgRunning = 0;
    /** Wall-clock of the most recent >0→0 bg-job transition; 0 = none since
     *  startup. waitidle deliveries hold for cfg.jobDoneGraceMs after this so
     *  bg-jobs' coalesced completion notice lands before our message. */
    let lastBgDrainAt = 0;
    let compacting = false;
    let cfg: SteerCfg = { promptWhenIdleWithBg: true, jobDoneGraceMs: 1000 };
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
        // waitidle items additionally require the post-drain grace window:
        // bg-jobs flips the status to running=0 IMMEDIATELY, but its actual
        // completion notice (carrying the job output the agent needs first)
        // fires ~coalesceMs later. Delivering before that lets the user's
        // prompt jump the notice — wrong order. If the notice wakes the agent
        // instead, isIdle() turns false and we wait for the next settle.
        const waitGrace = (): number => {
            if (!lastBgDrainAt) return 0;
            const remain = cfg.jobDoneGraceMs - (Date.now() - lastBgDrainAt);
            return remain > 0 ? remain : 0;
        };
        const idx = queue.findIndex((m) => {
            if (m.mode === "queue") return true;
            if (m.mode !== "waitidle" || bgRunning !== 0) return false;
            return waitGrace() === 0;
        });
        if (idx === -1) {
            updateStatus();
            // If the only blockers are waitidle items inside the grace window,
            // re-arm precisely for the remainder.
            const hasWaitIdle = queue.some((m) => m.mode === "waitidle" && bgRunning === 0);
            if (hasWaitIdle) armFlush(waitGrace() + 60);
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

    /** Park a message in the extension queue and arm delivery. */
    function enqueue(text: string, mode: QueuedMessage["mode"], ctx: ExtensionContext): void {
        queue.push({ text, mode, queuedAt: Date.now() });
        updateStatus();
        armFlush(300);
        ctx.ui.notify(
            mode === "waitidle"
                ? `⏳ Queued until FULLY idle (agent + ${bgRunning} bg job(s) clear) — /unqueue to edit`
                : "⏳ Queued — delivered when the agent finishes (/unqueue to edit)",
            "info"
        );
    }

    // ── bg-jobs awareness ─────────────────────────────────────────────────────
    try {
        pi.events.on(BG_STATUS_EVENT, (s: unknown) => {
            const status = s as { running?: number } | undefined;
            const prev = bgRunning;
            bgRunning = typeof status?.running === "number" ? status.running : 0;
            if (bgRunning > 0) lastBgDrainAt = 0; // new job → grace clock resets on next drain
            else if (prev > 0) lastBgDrainAt = Date.now(); // >0→0: start the grace window
            updateStatus();
            if (bgRunning === 0 && queue.some((m) => m.mode === "waitidle")) armFlush(cfg.jobDoneGraceMs + 120);
        });
    } catch {
        /* event bus unavailable */
    }

    // ── lifecycle events ──────────────────────────────────────────────────────
    pi.on("session_start", async (_event, ctx) => {
        lastCtx = ctx;
        compacting = false;
        lastBgDrainAt = 0;
        cfg = loadSteerSettings(ctx.cwd);
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

        // Agent idle and not compacting — normally pass through (no prompt).
        // Opt-in exception: prompt anyway when background jobs are running,
        // so you can choose "hold until the jobs drain" instead of starting
        // a turn that competes with them.
        const agentIdle = ctx.isIdle();
        if (agentIdle && !compacting && !(cfg.promptWhenIdleWithBg && bgRunning > 0)) {
            return { action: "continue" };
        }

        // No interactive UI (print / JSON mode) — pass through.
        if (!ctx.hasUI) return { action: "continue" };

        const idleWithBg = agentIdle && !compacting;

        // Show the single-keypress prompt (steer stays selectable: while
        // compacting it is internally downgraded to queue, never an error).
        const choice = await ctx.ui.custom<SteerChoice>(
            (_tui, theme, _kb, done) =>
                new SteerPromptComponent(event.text, theme, done, { compacting, bgRunning, idleWithBg }),
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

        if (idleWithBg) {
            // No turn is running: s/q start one immediately (bg jobs keep
            // running alongside); a holds delivery until agent AND jobs idle.
            if (choice === "waitidle") {
                enqueue(event.text, "waitidle", ctx);
                return { action: "handled" };
            }
            try {
                pi.sendUserMessage(event.text);
                ctx.ui.notify("◀ Sent — agent started; background jobs still running", "info");
            } catch (err) {
                if (isCompactionError(err)) {
                    compacting = true;
                    enqueue(event.text, "queue", ctx);
                } else {
                    ctx.ui.notify(`agent-steer: send failed: ${String(err)}`, "error");
                }
            }
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
                enqueue(content, "queue", ctx);
                return;
            }
            pi.sendUserMessage(content);
            ctx.ui.notify("◀ Steered — triggering response", "info");
        },
    });

    // ── /queue and /idlequeue — explicit queueing, bypasses the prompt ───────
    pi.registerCommand("queue", {
        description:
            "agent-steer: queue a message for after the agent finishes (extension-owned queue, no Alt+Up widget). Usage: /queue <text>",
        handler: async (args, ctx) => {
            lastCtx = ctx;
            const content = args?.trim();
            if (!content) {
                ctx.ui.notify("/queue <text>  — deliver after the agent fully finishes", "info");
                return;
            }
            enqueue(content, "queue", ctx);
        },
    });

    pi.registerCommand("idlequeue", {
        description:
            "agent-steer: queue a message until FULLY idle — no agent turn AND no background jobs running. Usage: /idlequeue <text>",
        handler: async (args, ctx) => {
            lastCtx = ctx;
            const content = args?.trim();
            if (!content) {
                ctx.ui.notify("/idlequeue <text>  — deliver only when the agent and all bg jobs are idle", "info");
                return;
            }
            enqueue(content, "waitidle", ctx);
        },
    });
}
