# Changelog

All notable changes to this project will be documented in this file.

---

## [1.1.0-pre.2] - 2026-05-06

> Fixes task instance over-spawning and notification storm. Based on daily throughput analysis.

### Fixed

- **Task over-spawning (P0)**: Each template spawned 2-6x duplicate instances per day instead of 1.
  - `todo_bridge.py` `spawn_instance()` now checks for existing active (pending/in_progress/blocked) child of the same template before creating new instance; reuses active one if found. Added process-level `fcntl` file lock per script name to prevent concurrent launches of the same script.
  - Spawn API route `POST /{template_id}/spawn` now defaults `replaceExisting=true` (was `false`). Active duplicate instances are automatically cancelled and archived when a new one spawns from the same template.
  - StuckTaskMonitor blocked-task recovery now skips tasks whose parent template already has another active sibling instance, preventing blocked→recovery→new spawn ping-pong loop.

- **Notification storm**: 50 unread notifications (40 recovery + 10 blocked) caused by repeated blocked↔recovered bounce.
  - Cooldown tightened: `recovered`, `blocked`, `zombie_blocked` → 60min (was 30min); `stalled` → 30min; assigned/completion → no cooldown.
  - `_shouldNotify()` now uses a type-specific default cooldown map (`_COOLDOWN_BY_TYPE`), with per-call override still supported.

### Added

- **`TodoTask` dedup and lock support**: `todo_bridge.TodoTask` now accepts `dedup=True` and `lock_name=None` parameters. When `lock_name` is set, a process-level file lock (`/tmp/todo_bridge_{name}.lock`) prevents concurrent script runs; when dedup is active (default), existing active template children are reused instead of spawning new ones.

### Changed

- **`todo_bridge._request()` auth**: Now uses `X-Agent-Secret` header for authentication (matching server route expectations).
- **`find_template()` enhanced**: Substring matching now also checks `find_template()` via `/scheduled/pending` and `?isTemplate=false&limit=200` for active instance lookup.

---

## [1.1.0-pre.1] - 2026-05-05

> Pre-release version. Fixes critical task completion signal delivery failure and adds robust observability infrastructure.

### Fixed

- **Task completion signal broken (P0)**: Fixed 3-layer cascading failure preventing completed tasks from being marked `completed`
  - Layer 1 (Environment): All 9 launchd plists used `/usr/bin/python3` (system Python 3.9) but `tushare` is installed in `/opt/homebrew/bin/python3` (Homebrew Python). Scripts crashed at `import tushare` before `todo_bridge.__exit__()` could fire.
  - Layer 2 (Signal): `todo_bridge.complete()` called `PUT /{id}` which was intercepted by `pending_validation` rewrite logic; `failed` status was rejected by both route validation and SQLite CHECK constraint.
  - Layer 3 (Logic): `PATCH /status?force=true` only bypassed `pending_validation` rewrite but not acceptance criteria check, causing 409 rejection.
  - Root cause: **no completion signal reached the server**, causing ZombieDetector → blocked → StuckTaskMonitor recovery → permanent bounce loop.

- **`failed` status not supported**: Added `failed` to `validStatuses` in routes/todos.js and ran SQLite CHECK constraint migration in db.js.

- **Force-complete bypass**: `PATCH /status?force=true` now also bypasses acceptance criteria checks, enabling the bridge to report completion without manual criteria confirmation.

- **Spawn template `task_category` inheritance**: `Todo.spawnFromTemplate()` now copies `task_category` from parent template to spawned instance (was defaulting to `general`).

### Added

- **`run_with_bridge.py` wrapper** (`scripts/run_with_bridge.py`): Safe execution wrapper that catches ANY crash (including import errors) and reports `failed` status to TODO Server. Prevents duplicate failure reporting when `TodoTask.__exit__` also handles the error.

- **ZombieDetector**: Every 10 minutes, scans `in_progress` tasks with >2h no heartbeat and marks them `blocked` to prevent permanent stuck state.

- **GlobalCleanup engine**: Every 6 hours, prunes expired `task_contexts` (>7 days), read `task_notifications` (>3 days), and enforces per-session retention limits (snapshot:30, inference:20, drive-orchestrator:100).

- **Notification cooldown**: `_shouldNotify(taskId, type, cooldownMs)` in-memory cache prevents same-type notification spam from StuckTaskMonitor (30min cooldown, auto-evict at >5000 entries).

- **Step-level heartbeat in `todo_bridge.py`**: `TodoTask` context manager now supports `task.step(name, progress, message)` for granular progress reporting and `task.complete_with_result()` for structured completion with data output metadata.

- **Template acceptance criteria**: 12 task templates now have JSON array `acceptance_criteria` defining concrete success conditions.

- **Frontend date grouping**: Web UI groups tasks by date (today/yesterday/specific date) with collapsible sections and purple left-border styling.

### Changed

- **Launchd plists updated**: All 9 tushare data-fetch plists now use `/opt/homebrew/bin/python3`, add `/opt/homebrew/bin` to PATH, include TODO_SERVER_URL/AGENT_ID/AGENT_SECRET env vars, and execute via `run_with_bridge.py` wrapper.

- **`todo_bridge.py` complete()**: Now uses `PATCH /{id}/status?force=true` for success and `PATCH /{id}/status` for failure, instead of `PUT /{id}` which was intercepted by validation logic.

- **WorkSnapshot interval**: 30s → 2min (reduces contexts table growth from ~12K rows/3 days to ~3K).

- **WorkSnapshot retention**: 100 → 30 per session (caps context table size).

- **Cleared template schedules**: 13 templates had their `schedule` field cleared so macOS launchd is the sole scheduler source (eliminates duplicate spawn from both launchd + DailyScheduler).

---

## [1.0.0] - 2026-05-01

### Features

- Task CRUD with 4-level priority, tags, dependencies, subtasks
- Focus Engine with LLM-enhanced auto-selection
- Heartbeat tracking with dynamic stuck detection
- Acceptance criteria with self-driven validation
- ValidationAgent (LLM Agent Loop, ReAct mode, max 10 iterations)
- Multi-agent collaboration (assign, transfer, notifications)
- Scheduled tasks (templates + DailyScheduler)
- DriveOrchestrator + ValidatorService auto-maintenance
- LLMInferencer background state inference
- CompletionReportBuilder structured reports
- Per-agent concurrent task limits
- LLM Provider hot-swap (OpenAI / Anthropic / MiniMax / Ollama)
- Web management interface
- PM2 cluster management (Server + 4 Hermes Agents)
- Hermes Skill integration (Python CLI + agents.yaml)
