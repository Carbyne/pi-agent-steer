# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
