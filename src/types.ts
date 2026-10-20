// ── Types ──────────────────────────────────────────────────────────────────────

export type SteerChoice = "steer" | "queue" | "waitidle" | "discard" | "edit";

export interface QueuedMessage {
    text: string;
    /** queue = deliver when the agent finishes;
     *  waitidle = deliver only when the agent is idle AND no background jobs run. */
    mode: "queue" | "waitidle";
    queuedAt: number;
}
