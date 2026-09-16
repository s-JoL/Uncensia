---
name: testing-uncensia
description: Run Uncensia WebUI and iOS simulator smoke tests against local fixture/stub servers on macOS.
---

# Uncensia UI testing

## WebUI
- Start the app from `uncensia/` with Node 24 (`node --import tsx src/server/main.ts`), using an isolated `UNCENSIA_DATA_DIR` when provided by the task. The root serves WebUI; API is `/v1`.
- If chat returns `Connection error` even though a local `e2e-stub` provider is configured, check the provider URL shown under Settings → Providers. `scripts/stub-openai.ts <port>` can restore a missing stub; the configured port must match.
- Use clipboard paste for access codes. `computer`/`type` may lowercase characters in password fields and cause a false `Invalid or expired access code`.

## iOS Simulator
- Build with the repo blueprint's Xcode 27 RC command and `xcodegen generate` first.
- Install the produced app to the target UDID, then launch with `SIMCTL_CHILD_UNCENSIA_SERVER_URL` and `SIMCTL_CHILD_UNCENSIA_ACCESS_CODE`; Springboard/openurl launches do not receive env.
- Fixture conversations do not seed `learning-history`; for UI-only history testing, create clearly labeled JSON records under `<fixture>/data/learning-history` and tap Skills → Refresh history.
- The app follows the server-selected language. A server bootstrap in English makes the new section display `Assistant change history`; zh localizations exist for Chinese deployments.

## Devin Secrets Needed
- None beyond the task-supplied access code/fixture code.
