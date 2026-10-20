# pi-agent-steer

Fork of [`@agnishc/edb-agent-steer`](https://github.com/agnishcc/pi-extention-monorepo/tree/main/packages/edb-agent-steer) (MIT, © Agnish Chakraborty), rewritten for Carbyne's environment.

When you submit a message while the agent is already running, a compact inline prompt shows five single-key options:

```
↵ "your message here"  (agent busy · 2 bg job(s))

s steer   q queue   a queue when fully idle   d discard   e edit
```

| Key | Action | Behaviour |
| --- | --- | --- |
| `s` | steer | Delivers before the next LLM call (pi's native steer) |
| `q` | queue | Delivers after the agent fully finishes |
| `a` | queue when **fully** idle | Delivers only when the agent is idle **and** no background jobs are running (listens to `pi-bg-jobs` on the `bg-jobs:status` event bus — same mechanism `pi-ralph-loop` uses) |
| `d` | discard | Throws the message away |
| `e` / Esc | edit | Restores the text to the editor |

When the agent is **idle**, messages pass through normally — no prompt appears.

## Why fork

1. **No Alt+Up dependency.** The stock flow routes queued messages through pi's built-in queue, which renders
   `↳ Alt+Up to edit all queued messages` — and Alt+Up is unusable in VSCode remote terminals on Windows
   (the arrow portion is swallowed). This fork keeps its **own** queue for `q`/`a`: messages never enter pi's
   queue widget at all, so the hint never appears. To get queued text back for editing:

   ```
   /unqueue    — pull all extension-queued messages back into the editor
   ```

   A status line (`⏳ N queued — /unqueue`) shows while anything is pending, including
   `(waiting for bg jobs)` when `a`-items are held by running background jobs.

2. **Compaction-safe.** pi rejects `sendUserMessage` while compaction is in progress
   (`Cannot submit a prompt while compaction is in progress`). The original extension could surface that
   as an extension error. This fork tracks `session_before_compact` / `session_compact` /
   `session_compact_failed`, parks everything in the extension queue during compaction, and drains it
   when the session settles. `/steer` during compaction degrades gracefully to queueing.

## Commands

- `/steer <text>` — explicit steer, bypasses the prompt (falls back to the extension queue if the agent
  is busy mid-compaction)
- `/queue <text>` — queue for delivery after the agent fully finishes (extension-owned; no Alt+Up widget)
- `/idlequeue <text>` — queue until **fully** idle: agent finished *and* zero background jobs running
- `/unqueue` — restore queued messages to the editor (the Alt+Up replacement)

## Install

```bash
pi install git:github.com/Carbyne/pi-agent-steer
```

Or in `~/.pi/agent/settings.json` under `packages`:

```json
"git:github.com/Carbyne/pi-agent-steer"
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono) ≥ 0.84
- Optional: [pi-bg-jobs](https://github.com/Carbyne/pi-bg-jobs) — without it, `a` behaves like `q`
  (no background jobs to wait for).

## License

MIT — original implementation © Agnish Chakraborty (`@agnishc/edb-agent-steer`), fork changes © Carbyne.
