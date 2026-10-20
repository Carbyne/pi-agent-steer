import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { SteerChoice } from "./types.ts";

// ── Component ──────────────────────────────────────────────────────────────────

export interface PromptContext {
    compacting: boolean;
    bgRunning: number;
    /** Agent idle but bg jobs running (promptWhenIdleWithBg): s/q send now, a holds. */
    idleWithBg?: boolean;
}

export class SteerPromptComponent {
    private cachedWidth?: number;
    private cachedLines?: string[];

    constructor(
        private readonly message: string,
        private readonly theme: any,
        private readonly done: (choice: SteerChoice) => void,
        private readonly ctx: PromptContext
    ) {}

    handleInput(data: string): void {
        if (matchesKey(data, "s")) this.done("steer");
        else if (matchesKey(data, "q")) this.done("queue");
        else if (matchesKey(data, "a")) this.done("waitidle");
        else if (matchesKey(data, "d")) this.done("discard");
        else if (matchesKey(data, "e") || matchesKey(data, "escape")) this.done("edit");
    }

    render(width: number): string[] {
        if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

        const th = this.theme;
        const maxMsgW = Math.max(10, width - 8);
        const preview = this.message.length > maxMsgW ? `${this.message.slice(0, maxMsgW - 1)}…` : this.message;

        const key = (k: string, label: string) => `${th.fg("accent", k)}${th.fg("dim", ` ${label}`)}`;

        const state = this.ctx.compacting
            ? "compacting…"
            : this.ctx.idleWithBg
              ? `agent idle · ${this.ctx.bgRunning} bg job(s)`
              : this.ctx.bgRunning > 0
                ? `agent busy · ${this.ctx.bgRunning} bg job(s)`
                : "agent busy";

        const lines: string[] = [
            "",
            truncateToWidth(`  ${th.fg("muted", "↵")}  ${th.fg("dim", `"${preview}"`)}  ${th.fg("muted", `(${state})`)}`, width),
            "",
            this.ctx.idleWithBg
                ? truncateToWidth(
                      `  ${key("s", "send now")}   ${key("a", "hold until bg idle")}   ${key("d", "discard")}   ${key("e", "edit")}`,
                      width,
                  )
                : truncateToWidth(
                      `  ${key("s", "steer")}   ${key("q", "queue")}   ${key("a", "queue when fully idle")}   ${key("d", "discard")}   ${key("e", "edit")}`,
                      width,
                  ),
            "",
        ];

        this.cachedWidth = width;
        this.cachedLines = lines;
        return lines;
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }
}
