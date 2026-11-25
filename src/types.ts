// ── Types ──────────────────────────────────────────────────────────────────────

export type SteerChoice = "steer" | "queue" | "waitidle" | "discard" | "edit";

export interface QueuedMessage {
    text: string;
    /** queue = deliver when the agent finishes;
     *  waitidle = deliver only when the agent is idle AND no background jobs run;
     *  steer = armed steer: held HERE (fully recallable) until the next tool
     *  boundary, then handed to core just-in-time (deliverAs: "steer") so it
     *  is still consumed before the next LLM call. */
    mode: "queue" | "waitidle" | "steer";
    queuedAt: number;
}
