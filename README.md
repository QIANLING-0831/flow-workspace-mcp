# flow-mcp

Local Model Context Protocol server that lets an AI agent operate [Google Flow](https://labs.google/fx/tools/flow) through your own signed-in Chromium session, wait for generated video or image assets, use the upscale choices actually offered by Flow, and download validated files into a local project.

It uses no Google generation API key. Subscription credits are consumed through the Flow website exactly as when you operate it manually.

> Status: early UI-automation release. Google Flow changes frequently. The server fails with diagnostics instead of silently clicking an uncertain control, but live selectors may need recalibration after Flow UI updates.

## Features

- Separate persistent Chromium profile for every managed Google account.
- One-click account connection that detects successful login automatically—no terminal confirmation step.
- Optional localhost CDP attachment to reuse an explicitly debug-enabled Chromium session.
- Per-account operation queue; different accounts can run independently.
- Video and image generation with model, aspect ratio, duration, output count, and reference files.
- Literal Flow asset-menu upscale support: `1x`, `2x`, `4x`, or `highest_available`.
- Never assumes that `4x` exists and never silently downgrades a requested factor.
- Persistent jobs for long-running generations.
- Browser download capture into any absolute project directory.
- `.flow.json` sidecar manifest containing prompt, settings, account ID, upscale choice, and job history.
- SHA-256, file size, and optional `ffprobe` metadata for downloaded media.
- Diagnostic screenshots on UI failures.
- Explicit `confirmCreditSpend: true` gate on generation and upscale tools.

## Requirements

- Node.js 20 or newer.
- Chromium or Google Chrome. Auto-detection prefers Chromium.
- A Google account with access to Flow in a supported region.
- Optional: `ffprobe` on `PATH` for video resolution, codec, and duration validation.

## Install

```powershell
git clone https://github.com/YOUR_USER/flow-mcp.git
cd flow-mcp
npm ci
npm run check
```

Playwright controls your locally installed Chromium/Chrome executable, so a separate bundled browser download is not required. Set `FLOW_MCP_BROWSER_EXECUTABLE` only when auto-detection cannot find it.

## Connect one or more accounts

Each managed account ID owns a different Chromium profile. The connection opens Flow and watches the page; after Google authentication succeeds it records the ready session and exits automatically. There is no “press Enter when done” step.

```powershell
npm run account -- connect personal "Personal Google Pro"
npm run account -- connect studio "Studio Google account"
npm run account -- list
```

Chromium opens at Flow. Complete Google sign-in or account verification in that browser window; completion is detected automatically. This first authentication interaction cannot safely be replaced by storing or typing the user's Google password. Cookies remain in the account's dedicated profile, so subsequent generations require no login work.

Agents can provide the same onboarding with `flow_connect_account`; users do not need the CLI.

### Reuse an existing Chromium session with CDP

If Chromium was deliberately started with a localhost remote-debugging port, connect directly to that signed-in session:

```powershell
npm run account -- connect personal "Main Chromium" --cdp http://127.0.0.1:9222
```

This mode does not copy or decrypt browser cookies. `flow-mcp` only accepts localhost CDP endpoints and does not close attached browsers. A normally running browser without remote debugging cannot be attached retroactively; use managed mode for the simplest reliable setup.

Default runtime data locations:

- Windows: `%LOCALAPPDATA%\flow-mcp`
- macOS: `~/Library/Application Support/flow-mcp`
- Linux: `$XDG_DATA_HOME/flow-mcp` or `~/.local/share/flow-mcp`

Override with `FLOW_MCP_DATA_DIR`. Never place or commit that directory inside a public repository.

## Build and connect an MCP client

```powershell
npm run build
```

Codex-style `config.toml`:

```toml
[mcp_servers.google_flow]
command = "node"
args = ["C:\\absolute\\path\\to\\flow-mcp\\dist\\index.js"]
startup_timeout_sec = 30
tool_timeout_sec = 1200

[mcp_servers.google_flow.env]
FLOW_MCP_HEADLESS = "0"
```

Generic MCP JSON used by several desktop clients:

```json
{
  "mcpServers": {
    "google-flow": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\flow-mcp\\dist\\index.js"]
    }
  }
}
```

Restart the MCP client after changing its configuration.

## Agent workflow

1. Call `flow_list_accounts` and select an account.
2. If necessary, call `flow_connect_account`; it detects when the account is ready automatically.
3. Optionally call `flow_inspect_account` to inspect current Flow UI capabilities.
4. Call `flow_generate_video` or `flow_generate_image` with `confirmCreditSpend: true` only after the user explicitly requested generation.
5. If a long generation returns `processing`, poll `flow_job_status`.
6. A timed-out job becomes `ready` when its asset is detected. Call `flow_upscale_video` if still needed, then `flow_download_job`.

Example video request:

```json
{
  "accountId": "personal",
  "prompt": "A cinematic tracking shot through a rainy miniature neon city, shallow depth of field, reflections on wet streets, no text",
  "model": "Veo 3.1 - Fast",
  "aspectRatio": "16:9",
  "durationSeconds": 8,
  "outputs": 1,
  "referenceFiles": [],
  "upscale": "2x",
  "outputDirectory": "C:\\projects\\my-remotion-video\\public\\generated\\flow",
  "download": true,
  "timeoutSeconds": 600,
  "confirmCreditSpend": true
}
```

For Remotion, saving under `public/generated/flow` lets compositions use a returned file with `staticFile("generated/flow/<file>.mp4")`.

## Upscaling behavior

Upscaling is treated as a Flow asset action, not a guessed resolution conversion:

1. The server opens the generated video's context menu using the same right-click interaction available to the user.
2. It reads the available upscale labels.
3. An exact request such as `2x` fails if `2x` is not offered.
4. `highest_available` ranks only the options present in that menu.
5. If upscaling creates another processing job, the state remains persistent and pollable.

The server does not use local interpolation or an unrelated upscaler when Flow lacks the requested option.

## Multiple accounts

Use a stable local ID such as `personal`, `studio`, or `backup`. An account ID is not an email address and is safe to include in job manifests. Email addresses and Google credentials are never required by MCP tools.

Operations for one account are serialized to prevent two agents from changing the same Flow page simultaneously. Separate accounts use separate Chrome contexts and can progress independently.

## Tools

| Tool | Purpose | Spends credits |
| --- | --- | --- |
| `flow_list_accounts` | List local profiles | No |
| `flow_connect_account` | Connect managed Chromium or an explicit localhost CDP session | No |
| `flow_inspect_account` | Inspect login/UI controls and save a screenshot | No |
| `flow_generate_video` | Generate, optionally upscale, and download video | Yes |
| `flow_generate_image` | Generate/edit and download image | Potentially |
| `flow_job_status` | Poll a persistent job | No |
| `flow_upscale_video` | Upscale an existing video job | Potentially |
| `flow_download_job` | Download an already-created asset | No new generation |

## Diagnostics

Diagnostics and job state live under the application-data directory:

```text
flow-mcp/
  accounts.json
  profiles/<account-id>/
  jobs/<job-id>.json
  diagnostics/*.png
```

On a `ui_changed` error, open the returned screenshot, confirm Flow's current wording, and update semantic role/text selectors in `src/flow-adapter.ts`. Avoid hashed class names.

## Limitations and responsible use

- This is browser automation, not an official Flow API.
- It can break when Google changes Flow's interface.
- It does not bypass CAPTCHA, verification, quotas, regional availability, safety filters, or access controls.
- A first Google authentication must be completed by the account owner unless an explicitly debug-enabled, already-signed-in Chromium session is attached. The project never copies cookies or automates passwords.
- Keep the browser headed for first-time authentication and troubleshooting.
- Generated output, watermarks, credit costs, and model availability depend on the Google account, plan, region, and current Flow product behavior.
- You are responsible for complying with Google's terms and policies.

## Development

```powershell
npm run typecheck
npm test
npm run build
npm run check
```

CI runs on Windows and Linux with Node 20 and Node 24. Live Google account tests are intentionally excluded from CI.

## License

MIT. This repository is a clean-room implementation and contains no Proxima source code.
