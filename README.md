# Pi Background

Start one-shot background [Pi coding-agent](https://github.com/earendil-works/pi-mono) subagents without blocking the parent session. Tasks have a durable project registry, origin metadata, and completion notifications for the parent to review.

## Install

Once published to npm:

```bash
pi install npm:@comput/pi-background
```

Until then, install directly from GitHub:

```bash
pi install git:github.com/mbundgaard/PiBackground
```

Start a new Pi session or run `/reload` after installation. Pi must be installed, authenticated, and available as `pi` on PATH so the extension can launch child processes. Node.js 20.3 or newer is required; development checks use Node.js 22 or 24.

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

When a task finishes, the extension queues a follow-up in the parent session. The parent reads the output, verifies the result, and decides whether to respond. Origin metadata records supported request markers, including Telegram, WhatsApp, and scheduler requests; it is not authorization or a guarantee of delayed message delivery.

## Local data and limitations

Task prompts, combined stdout/stderr, metadata, and the registry live under:

```text
<project>/.pi/background/
```

Add `.pi/background/` to your project's `.gitignore`. These files may contain sensitive prompts, outputs, and request identifiers; they are not automatically cleaned up.

- Workers share the project's working directory. They are not separate worktrees, containers, or security sandboxes and may modify the same files.
- Workers inherit most environment variables and may access local Pi configuration and credentials. Known messaging environment variables and outward/recursive tools are filtered, and some bridge-send shell patterns are blocked. These are best-effort guardrails, not a security boundary.
- The parent owns outward communication. Workers must not send Telegram/WhatsApp messages or start nested background tasks.
- Completion delivery relies on the parent process remaining available. The registry is durable, but this is not a persistent job service.
- Timeouts request termination of the immediate child; full process-tree termination is not guaranteed.

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

CI checks type safety, smoke tests, and package contents on Windows and Linux with Node.js 22 and 24. Only source, package metadata, this README, and the license are published.

## Publishing

This repository follows PiTelegram's public scoped-package and GitHub Actions Trusted Publishing approach. The intended npm name is `@comput/pi-background`; preparing this repository does not publish it.

1. Ensure you have publish access to the `@comput` npm scope. If npm requires an initial package publication before configuring a trusted publisher, bootstrap it from a trusted local machine with `npm publish --access public --provenance=false` after validation. Authenticate locally; never commit credentials.
2. In the npm package's Trusted Publisher settings, select GitHub Actions and configure owner `mbundgaard`, repository `PiBackground`, workflow filename `publish.yml`. The workflow does not use a GitHub environment.
3. Commit the source, metadata, and lockfile. For later versions, update both package files (for example, `npm version patch`).
4. Publish a GitHub release tagged `v<package version>` (initially `v0.1.0`), or manually dispatch the publish workflow for an unpublished version.

The workflow validates the package and uses npm OIDC Trusted Publishing with public access and signed provenance, without an npm token secret. Release tags must match `package.json`. Already-published versions cannot be republished; if bootstrapping published `0.1.0`, increment the version before the first Actions publication.

## License

[MIT](LICENSE)
