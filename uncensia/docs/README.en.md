# Uncensia documentation

[English](README.en.md) · [简体中文](README.md) · [Project overview](../../README.md)

The released client is the responsive Web app. This guide covers installation, everyday use, extension points, and maintenance. Dated engineering audits in this directory are historical evidence, not a statement about your current deployment.

## Installation and configuration

Use Node.js 24+ and run `npm ci`, `npm run build`, and `npm start` from `uncensia/`. The default address is `http://127.0.0.1:8090`. The first access code appears in the server log; use Settings to manage access codes, optional TOTP, and signed-in devices.

| Environment variable | Purpose |
|---|---|
| `UNCENSIA_ROOT` | Application root; normally inferred from the installed source |
| `UNCENSIA_DATA_DIR` | Data directory; defaults to `uncensia/data` |
| `UNCENSIA_HOST` / `UNCENSIA_PORT` | Listening address; defaults to `127.0.0.1:8090` |
| `UNCENSIA_TRUST_PROXY` | Set to `1` only behind your trusted reverse proxy |
| `OPENROUTER_API_KEY` | First-boot OpenRouter chat credential |
| `EMBEDDING_API_KEY` | First-boot embedding credential; use your OpenRouter key for the default embedding endpoint |
| `SIRAY_API_KEY` | First-boot cloud image/video credential |
| `TAVILY_API_KEY` | First-boot web-search credential |

Credentials can instead be entered in Settings. Environment credentials are imported only on first boot, without replacing an existing saved key. The chat and embedding key slots are independent. No credentials, personal memories, files, or conversations ship with the application.

Fresh installations configure HY4 Preview as their only chat model and Qwen3 Embedding 8B for retrieval, both on OpenRouter. Media defaults are local Lustify V10 Krea Turbo, Siray Seedream 5.0 Pro editing, and three Wan 3.0 video profiles. Default enabled capabilities include memory, hybrid file retrieval, web search, Studio, and workspace read/write/shell tools. Required keys and local model files are still yours to provide. Set the workspace deliberately in Tools and permissions; it initially points to the checkout root.

For local image generation, install ComfyUI separately. The packaged [workflow](../workflows/lustify-v10-krea-turbo.json) lists the exact UNet, text encoder, VAE, controls, and node types. It uses 8 steps, CFG 1, Euler, beta scheduling, and sampling shift 4. Model weights and a ComfyUI installation are not included. Keep those workflow requirements intact or register a separate profile for a different setup.

## Using Uncensia

**Chat** is the ordinary starting point. Attach documents or images, ask questions, write, research, or generate media. The agent reads appropriate skills on demand. Editing, retrying, branches, and follow-ups preserve explicit conversation state.

**Studio** is a direct generation interface. Select an operation and model, fill its actual schema fields, and track the job. Select reference images in the intended order. Completed results can be inspected, edited, reused, and traced to their sources. A failed generation remains a failed job with the provider’s error; it does not silently change models.

**Library** brings files, creations, search, and memory together. Editing a document changes its searchable version. Memory is user-owned, editable, and initially empty. A fictional character’s history is separate from personal memory.

**Tasks** makes long and scheduled work visible. Tasks belong to conversations and preserve goals, progress, schedules, and run limits. Pause or cancel them from the interface. The server must keep running to execute a schedule; closing the browser does not stop the server. Resuming work after a restart depends on its recorded state and the backend job, rather than assuming every interrupted operation succeeded.

**Settings** manages providers, model identity and capacity, capability permissions, MCP, skills, prompts, task administration, and sign-in. Changes to memories, prompts, and skills are read for subsequent model work; changing running program code additionally needs verification and restart.

## Languages

Web provides English and Simplified Chinese. The login screen and sidebar include a language selector. The first visit uses the browser language; the saved selection applies to this device. Language switching reloads the app and preserves persisted chat drafts. Save settings forms before switching.

Native iOS includes both language resources and uses the preferred app language selected in iOS Settings. It remains a development client and requires an Apple environment for compilation, interaction, and accessibility validation. The retired Flutter client and its dedicated tooling have been removed.

Application labels are translated. User documents, conversations, custom prompts, provider model names, and upstream diagnostics retain their original text. See the [localization maintenance guide](16-localization.md).

## Extension and architecture map

| Area | Source |
|---|---|
| Product contracts and shared types | `src/shared/types.ts` |
| Pi sessions, model runs, context, background tasks | `src/server/agent/` |
| Provider/model registry and discovery | `src/server/models/` |
| Media adapters and durable job queue | `src/server/generation/` |
| Agent tools and managed skills | `src/server/tools/`, `skills/` |
| Retrieval and document indexing | `src/server/rag/` |
| HTTP routes and authentication | `src/server/http/` |
| Web screens and translations | `src/web/` |
| Native SwiftUI client | `native-ios/` |

Keep semantic decisions with the agent. Code enforces explicit model IDs, schemas, references, permissions, ordering, and state transitions. Use Pi’s native session, tool, compaction, and cancellation mechanisms rather than implementing a second agent loop. Media generation shares one persistent job path between Chat and Studio.

MCP supports local stdio and remote Streamable HTTP. Skills are standard `SKILL.md` files with metadata and written procedures, loaded when needed. Packaged prompts, skills, and workflows update only when their recorded hashes still match the installed copy; user edits and deliberate deletions are retained. First-install model defaults never overwrite an existing installation.

The detailed engineering contracts are currently maintained in Chinese: [product](00-product.md), [architecture](01-architecture.md), [agent](02-agent.md), [generation](03-generation.md), [capabilities](04-capabilities.md), [HTTP API](05-api.md), [clients](06-clients.md), [Pi integration](07-harness.md), [acceptance](08-acceptance-patterns.md), and [design principles](09-design-principles.md). Shared types and database schema are authoritative for exact fields. Historical audit reports remain in their original language.

## Updates, backup, and recovery

1. Check for active conversations and generation jobs; record the running version.
2. Stop the server and back up all of `data/`, including `master.key`, SQLite files, JSONL sessions, media, prompts, skills, and workflows. Copying only a live SQLite main file can omit WAL writes.
3. Update source and run `npm ci`, `npm run typecheck`, `npm run audit`, and `npm run build`.
4. Verify against a data copy using a separate directory and port. Never let two processes write the same data directory.
5. Start the intended installation and verify `/v1/health`, sign-in, history, media, and configured tools.

Keep code, dependencies, and data backups together for rollback. Conversation JSONL exports omit media bytes and are not a full backup. The vector index can be rebuilt; it cannot replace original documents.

Old versions stored a different conversation tree in SQLite. This version refuses incompatible databases before altering history. There is no general one-click migration: a conversion must cover the schema, Pi session entries, branches and current leaves, projections, media references, prompts, and keys. Validate an offline copy first. Do not bypass the format check by merely adding columns.

## Validation

`npm run audit` uses temporary data and test providers. It covers session replay, tool contracts, context freshness, memory and retrieval, permissions, authentication, media, tasks, localization, and fresh-install defaults. These checks do not establish the creative quality of a live model.

The [public cinematic showcase](showcase/README.md) records real generation inputs and outputs separately. Native iOS needs Xcode build and device testing; a Windows API fixture is not a substitute.

## Upgrading an existing installation after the rename

The source directory is now `uncensia/`. Stop the old service before changing launch commands. Set `UNCENSIA_DATA_DIR` to your existing data directory, or move that whole directory to `uncensia/data/`; do not initialize a second empty installation. Keep `master.key`, media, sessions, and credentials together.

Existing `luma.sqlite` databases, `LUMA_*` environment variables, browser preferences, login cookies, and workflow declarations remain readable. New settings use `UNCENSIA_*` and take precedence. Bundled skills update only if unedited; user edits and deletions remain yours. Historical conversation text is not rewritten for branding.

On the original Windows development machine, data, dependencies, builds, logs, and the tunnel runtime now live under `uncensia/`; the database is `data/uncensia.sqlite`. Only `runtime/node` links to the protected physical installation at `luma/runtime/node`. A `luma/data` link points to the new data directory so historical attachment paths still resolve. Old launchers and source-directory links have been removed. New clones do not need these machine-specific links.
