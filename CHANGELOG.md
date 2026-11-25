# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.5

### Fixed / Changed

- **Steered commands are now recallable (`/unqueue` works on them).**
  Previously `s` / `/steer` handed the message to pi's core steering queue
  immediately — after that the extension owned nothing: `/unqueue` couldn't
  see or recall it, and the only core affordance (Alt+Up) is exactly the
  broken one on Windows/VSCode remote terminals. Now armed steers live in the
  extension-owned queue and are handed to core **just-in-time at the tool
  boundary** (`tool_result`/`turn_end` triggers) — which is precisely when
  core consumes the steering queue anyway (after the turn's tool calls,
  before the next LLM call), so delivery semantics are unchanged while
  cancel/recall (`/unqueue`, editor restore) works until that last moment.
  Send rejections re-queue for the next boundary; compaction mid-flight
  demotes to normal queued delivery at settle; steers still armed when the
  agent settles go out as ordinary sends (re-steering an idle agent makes no
  sense). Battery gains five T14-class T3 checks for the lifecycle.

## 0.3.4

### Fixed

- **Queued prompts no longer vanish while bg jobs run.** `pi.sendUserMessage`
  returns a Promise — when a coalesced bg-jobs completion notice (or subagent
  injection) started a turn between our `isIdle()` check and the send, the send
  rejected asynchronously, the sync try/catch missed it, and the message was
  silently dropped from the queue. Any send failure (sync throw OR async
  rejection) now re-queues the item and retries with backoff; user input is
  never lost. Added a `hasPendingMessages()` pre-check, throttled
  "delivery blocked" warnings, and a regression test that rejects the send
  exactly once mid-flush.

## 0.3.3

### Fixed

- Flush loop is now self-healing: whenever items remain queued but delivery is
  blocked (stale ctx, missed settle events, sparse-event harnesses), a watchdog
  re-arms the flush instead of stranding items forever.

## 0.3.2

### Fixed

- **waitidle ordering race with bg-jobs completion notices.** bg-jobs flips
  `bg-jobs:status` to `running: 0` the instant a job exits, but its actual
  completion notice (the message carrying the job output) is emitted ~400 ms
  later via a coalescing timer. The old flush armed on the status event at
  300 ms, so `a`/`/idlequeue` messages started their turn BEFORE the agent
  ever saw the job result. waitidle deliveries now hold for a grace window
  after the drain (`"agentSteer": { "jobDoneGrace": "1s" }`, default 1s —
  same idea as ralph-loop's `--job-grace`); and if the notice wakes the agent
  in the meantime, delivery additionally waits for the next settle.

## 0.3.1

### Changed

- `promptWhenIdleWithBg` now defaults to **true** (the prompt appears when the
  agent is idle but background jobs are running). Opt out with
  `"agentSteer": { "promptWhenIdleWithBg": false }`.

## 0.3.0

### Added

- Setting `"agentSteer": { "promptWhenIdleWithBg": true }` — shows the same
  single-keypress prompt when the **agent is idle but background jobs are
  running** (normally input just starts a turn immediately). In that state:
  `s` **send now** (starts the turn alongside the jobs), `a` **hold until bg
  idle** (parks in the extension queue, delivered when agent AND jobs are
  clear), `d` discard, `e`/Esc edit. The prompt line relabels to match the
  state (`agent idle · N bg job(s)`). Default off — input passes through
  unchanged.

## 0.2.0

### Added

- `/queue <text>` — queue directly without the inline prompt (extension-owned queue;
  delivered when the agent finishes)
- `/idlequeue <text>` — queue until FULLY idle: agent done AND zero bg-jobs running
  (listens on `bg-jobs:status`, like the `a` key choice)

## 0.1.0 — initial fork of @agnishc/edb-agent-steer

### Changed

- `queue` no longer routes through pi's built-in follow-up queue: messages are held in an
  extension-owned queue and delivered via `sendUserMessage` when the agent settles. This removes
  the `↳ Alt+Up to edit all queued messages` core UI from the flow — that binding is broken in
  VSCode remote terminals on Windows. `/unqueue` restores queued text to the editor instead.

### Added

- `a` — **queue when fully idle**: delivers only when the agent is idle *and* zero background
  jobs are running, via the `bg-jobs:status` event bus (pi-bg-jobs), mirroring pi-ralph-loop's
  job-awareness. Status line shows `(waiting for bg jobs)` while held.
- Compaction tracking (`session_before_compact` / `session_compact` / `session_compact_failed`):
  no `sendUserMessage` is ever attempted mid-compaction; everything parks in the extension queue
  and drains on settle. `/steer` mid-compaction degrades to queueing with a notice.
- `/unqueue` command (Alt+Up replacement).
- Queue status line: `⏳ N queued — /unqueue`.

### Preserved from upstream

- `s` steer (native mid-turn steer), `d` discard, `e`/Esc edit-restore, idle pass-through,
  non-UI pass-through, `/steer <text>` command, single-keypress inline prompt.
