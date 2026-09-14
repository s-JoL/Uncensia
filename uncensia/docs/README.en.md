# Documentation

[简体中文](README.md) · [Project overview](../../README.md)

Uncensia is a self-hosted, single-user studio for personal AI creation and companionship: chat, agent, files, memory and image/video generation collaborate in one space, everything runs on your own keys (BYOK), and there is no app-level content filter — safety is handled by upstream and downstream components. Web and native iOS share one service, one dataset and one wire contract.

## Start here

- [Creative guide: book illustrations, roleplay and interleaved stories](guide.en.md)
- [Real generation examples and parameters](showcase/README.md)
- [Native iOS build and connection guide](15-ios-native.md) (Chinese)

## Install and configure

Install Node.js 24+ and run from `uncensia/`:

```bash
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:8090`. The first access code is printed in the server log. Configure providers and keys in Settings, then select chat and generation models. Local ComfyUI requires a separate installation and the workflow’s model files; cloud features use your provider accounts.

| Environment | Purpose |
|---|---|
| `UNCENSIA_DATA_DIR` | Data directory; defaults to `uncensia/data` |
| `UNCENSIA_ROOT` | Application root; normally inferred |
| `UNCENSIA_HOST` / `UNCENSIA_PORT` | Defaults to `127.0.0.1:8090` |
| `UNCENSIA_TRUST_PROXY` | Set to `1` only behind a trusted reverse proxy |
| `OPENROUTER_API_KEY` | First-install chat credential |
| `EMBEDDING_API_KEY` | Independent first-install embedding credential |
| `SIRAY_API_KEY` / `TAVILY_API_KEY` | First-install media / search credentials |

Saved credentials are not overwritten by environment variables on later starts. Fresh installations seed GLM 5.3 Flash (OpenRouter) and MuseSpark 1.3 (OpenCode, free) for chat, Qwen3 Embedding 8B for retrieval, Siray Seedream 5.0 Pro for images (generate, edit and composite), Siray Wan 3.0 for video, and Lustify V10 as a local ComfyUI option. Defaults do not include keys, model weights or provider credit. Existing installations retain their model choices.

To connect a phone, use an address reachable from it and configure the server’s listening address. For remote access, use a controlled HTTPS reverse proxy. Manage access codes, TOTP and signed-in devices in Settings.

## iOS from source

On macOS with Xcode and XcodeGen, run `bash scripts/native-ios.sh prepare`, open `native-ios/Uncensia.xcodeproj`, and select your development team for device signing. The SwiftUI client supports iOS 18+, iPhone and iPad. It includes chat, projects, tasks, Studio, Library, settings and media viewing. Source availability does not imply an App Store release.

Run `bash scripts/native-ios.sh build` or `bash scripts/native-ios.sh test` for simulator validation. The default test destination is iPhone 17 Pro; override it with `UNCENSIA_IOS_DESTINATION`.

## Updates and backup

1. Stop the server and back up the **entire data directory**, including `master.key`, SQLite files, JSONL sessions and media.
2. Update source, install dependencies, then run typecheck, audit and build.
3. Validate a data copy with a separate directory and port before restarting the intended installation.
4. Check sign-in, history, media and configured tools.

Never run two servers against one data directory. A conversation export omits media bytes and is not a complete backup. Restore matching code, dependencies and data for rollback. Older SQLite conversation-tree formats require offline conversion; the server refuses incompatible history rather than silently starting empty. See [operations](12-operations.md) for details.

## Development map

| Area | Reference |
|---|---|
| Product and design | [Scope](00-product.md), [principles](09-design-principles.md) |
| Server and storage | [Architecture](01-architecture.md) |
| Sessions, context and tasks | [Agent](02-agent.md) |
| Images and video | [Generation](03-generation.md), [Siray](13-siray.md) |
| Models, skills, knowledge and MCP | [Capabilities](04-capabilities.md) |
| Shared client protocol | [HTTP API](05-api.md) |
| React and SwiftUI | [Clients](06-clients.md), [localization](16-localization.md) |
| Pi integration | [Host boundaries](07-harness.md) |
| Regression and real workflows | [Validation](08-acceptance-patterns.md) |

Detailed engineering references are maintained in Chinese. Implementation diaries are available through Git history. Runtime instructions in `skills/` remain part of the product.
