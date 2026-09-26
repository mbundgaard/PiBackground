# Pi Background

Run background [Pi coding-agent](https://github.com/earendil-works/pi-mono) tasks, review their results in a durable session inbox, and schedule main or background work without execution backlogs.

**Development status:** the inbox and scheduling features below are unreleased source changes. npm `0.1.0` provides the original `bg_start` behavior.

## Install

Install the published version:

```bash
pi install npm:@comput/pi-background
```

Alternatively, install the committed source from GitHub:

```bash
pi install git:github.com/comput-sh/pi-background
```

Start a new Pi session or run `/reload` after installation. Pi must be installed and authenticated. Workers launch the resolved Pi package's CLI directly through the current Node.js executable, without a shell. Node.js 20.3 or newer is required; development checks use Node.js 22 or 24. The source is validated against Pi 0.85.1.

The package ships TypeScript source, loaded directly by Pi; there is no build step or standalone executable.

## Usage

Ask Pi to delegate a focused task, for example:

> Start a background task named "review-tests" to review the test coverage. Do not change files. Return gaps and suggested tests.

The `bg_start` tool accepts:

| Parameter | Purpose |
| --- | --- |
| `name` | Required short task name; normalized to a project-wide scope |
| `prompt` | Required complete task brief, including limits and validation |
| `timeoutSeconds` | Optional positive timeout |
| `provider` | Optional child Pi provider |
| `model` | Optional child Pi model |
| `thinking` | Optional child Pi thinking level |

The tool returns immediately with the task ID, PID, origin, and output/metadata paths. A second running task with the same normalized name in the project is rejected. Dead tasks are marked stale when the registry is next accessed.

When a task finishes, its final assistant text and outcome are saved separately from diagnostic logs. The owning main session receives a review notification only when idle. Main reviews the result, acknowledges it, and decides whether to respond. Origin metadata records supported request markers, including Telegram, WhatsApp, and scheduler requests; it is not authorization or a guarantee of delayed message delivery.

## Result inbox

The inbox retains **completed results**, not jobs waiting to execute. It is scoped to the persistent main-session ID and project directory.

| Tool call | Purpose |
| --- | --- |
| `bg_inbox` with `action: "list"` | List unacknowledged completions; `includeAcknowledged` includes reviewed results |
| `bg_inbox` with `action: "get", taskId` | Read a structured outcome and final answer, with paths to logs |
| `bg_inbox` with `action: "ack", taskId` | Mark a reviewed result acknowledged; does not delete it or send a reply |

Lists and final answers support `offset` and `limit` pagination. Tool responses are bounded to 10,000 characters; use smaller pages if necessary. Logs are not injected into the result inbox. The JSON event log can include thinking and tool traffic; treat it as sensitive local diagnostic data.

- Reading is not acknowledgment. Acknowledgment is explicit and idempotent.
- Each task has one stable result ID (its task ID). Spawn error and close events cannot create duplicate results.
- Notifications are best-effort and emitted once per activation. Unacknowledged results can be announced again on reload/resume; the durable inbox, not the notification, is authoritative.
- No notification interrupts a busy main session. Main retains responsibility for outward communication.
- Switching to a different session or forking does not inherit inbox ownership. Resume the original session to review its results.
- Existing registry entries with an owner session ID remain accessible; legacy tasks without one are not assigned to the currently open session.

## Session-owned schedules

Ask Pi, for example:

> In one minute, then every five minutes, check the test status in the background. Do not change files.

Pi can call:

```json
{
  "name": "test-status",
  "prompt": "Check test status without changing files; return a concise result.",
  "target": "background",
  "when": "+1m",
  "intervalSeconds": 300,
  "timeoutSeconds": 120
}
```

Use `bg_schedule_create` with these arguments. Omit `intervalSeconds` for a one-shot. `when` accepts a future ISO timestamp with an explicit timezone or `+30s`, `+10m`, `+1h`, `+1d`. This version supports fixed intervals, **not cron**. Intervals range from one second to one year; at most 100 schedules are stored per session.

| Tool | Purpose |
| --- | --- |
| `bg_schedule_create` | Create a one-shot or recurring schedule owned by this session |
| `bg_schedule_list` | List schedules and their latest dispatch/skip outcome |
| `bg_schedule_enable` | Pause or enable using `scheduleId` and `enabled` |
| `bg_schedule_delete` | Delete a schedule; already-started tasks and saved results remain |

### No queueing or catch-up

- Schedules run only while their owning main session is open in this project. No daemon or independent scheduler process is started.
- **Main target:** runs only when main is idle, with no pending messages or blocking UI prompt. Otherwise that trigger is skipped. Main uses its current model and settings; worker-specific options are rejected.
- **Background target:** may start while main is busy, but a running worker from the same schedule prevents overlap. Background options include `timeoutSeconds`, `provider`, `model`, and `thinking`.
- Triggers missed while closed, paused, reloading, or asleep are discarded. Recurring schedules advance to their next future deadline; expired one-shots are consumed, not replayed.
- A one-second polling timer allows up to 1.5 seconds of scheduling jitter. Longer delays skip the trigger. Multiple simultaneously due main jobs do not become a queue.
- Triggers are durably consumed before dispatch. A crash between consumption and execution can lose that run; it will **not** be replayed.
- Main history records dispatch requests, not proof of model execution or success. Background task IDs link to actual outcomes in `bg_inbox`.
- Only resume an owning session in one process at a time. Separate sessions can each have their own schedules.

These tools are provided by Pi Background itself and do not depend on other scheduling or inter-agent extensions.

## Local data and limitations

Task prompts, JSON event logs, separate stderr logs, structured results, metadata, the registry, and schedule definitions live under:

```text
<project>/.pi/background/
```

Add `.pi/background/` to your project's `.gitignore`. These files may contain sensitive prompts, outputs, and request identifiers; they are not automatically cleaned up.

- Workers share the project's working directory. They are not separate worktrees, containers, or security sandboxes and may modify the same files.
- Workers inherit most environment variables and may access local Pi configuration and credentials. Known messaging environment variables and outward/recursive tools are filtered, and some bridge-send shell patterns are blocked. These are best-effort guardrails, not a security boundary.
- The parent owns outward communication. Workers must not send Telegram/WhatsApp messages or start nested background tasks.
- Reloading the parent does not discard saved results. A still-running worker can complete into the inbox through its original process callbacks without using a stale Pi API. Closing/killing the parent process can interrupt capture; missing worker completions become stale rather than being reported as successful.
- Timeouts request termination of the immediate child; full process-tree termination is not guaranteed. The task stays running until process close, preventing premature overlapping runs.
- Registry and schedule updates use a shared heartbeat lock and atomic replacement. Abandoned locks become recoverable after two minutes. Do not manually remove live locks.
- Before upgrading from npm `0.1.0`, finish existing workers and close/reload all old extension instances. Old and new versions use different lock protocols and must not write the same registry concurrently.
- The result parser bounds individual event lines to 4 MiB of text; oversized events are omitted from structured results and retained in the log. Incomplete/aborted/error final responses are failures even if the child exits with code zero.

## Development

```bash
npm ci
npm run validate
npm run pack:check
```

Try the checkout in Pi:

```bash
pi -e .
```

CI checks type safety, unit/integration tests, and package contents on Windows and Linux with Node.js 22 and 24. Tests cover result parsing, spawn failures, timeouts, inbox recovery/ownership, concurrent storage updates, and scheduler lifecycle/skip behavior without making model calls. Only source, package metadata, this README, and the license are published.

## Publishing

This repository follows PiTelegram's public scoped-package and GitHub Actions Trusted Publishing approach. The intended npm name is `@comput/pi-background`; preparing this repository does not publish it.

1. Ensure you have publish access to the `@comput` npm scope. If npm requires an initial package publication before configuring a trusted publisher, bootstrap it from a trusted local machine with `npm publish --access public --provenance=false` after validation. Authenticate locally; never commit credentials.
2. In the npm package's Trusted Publisher settings, select GitHub Actions and configure owner `comput-sh`, repository `pi-background`, workflow filename `publish.yml`. The workflow does not use a GitHub environment.
3. Commit the source, metadata, and lockfile. For later versions, update both package files (for example, `npm version patch`).
4. Publish a GitHub release tagged `v<package version>` (initially `v0.1.0`), or manually dispatch the publish workflow for an unpublished version.

The workflow validates the package and uses npm OIDC Trusted Publishing with public access and signed provenance, without an npm token secret. Release tags must match `package.json`. Already-published versions cannot be republished; if bootstrapping published `0.1.0`, increment the version before the first Actions publication.

## License

[MIT](LICENSE)
