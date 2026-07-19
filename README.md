# flow-mcp

Local Model Context Protocol server that lets an AI agent operate [Google Flow](https://labs.google/fx/tools/flow) through your own signed-in Chromium session, wait for generated video or image assets, use the upscale choices actually offered by Flow, and download validated files into a local project.

It uses no Google generation API key. Subscription credits are consumed through the Flow website exactly as when you operate it manually.

> Status: early UI-automation release. Google Flow changes frequently. The server fails with diagnostics instead of silently clicking an uncertain control, but live selectors may need recalibration after Flow UI updates.

## Features

- One-click Flow Login Bridge that reuses Google accounts already signed into normal Chromium.
- Separate persistent Flow session for every selected Google account.
- No email, password, 2FA, cookie JSON, browser restart, or terminal confirmation during account connection.
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
- The bundled Flow Login Bridge extension, installed once in the normal browser.
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

## One-time bridge installation

The bridge extension is bundled in `extension/`. It only reads Google cookies after the user clicks **Connect Flow**, and sends them to the running MCP server over `127.0.0.1`. It cannot contact a remote server with those cookies and never reads passwords or 2FA codes.

On Windows, run:

```powershell
npm run install-extension
```

This copies the extension folder path and opens Chromium's extension page. Enable **Developer mode**, choose **Load unpacked**, and paste the copied `extension` folder path. This one-time install does not restart Chromium. A published Chrome Web Store package can replace this unpacked-install step for end users.

## Connect one or more accounts

Start account connection from an MCP agent with `flow_connect_account`, or from the CLI:

```powershell
npm run account -- connect personal "Personal Google Pro"
npm run account -- connect studio "Studio Google account"
npm run account -- list
```

While the connection waits:

1. Click **Flow Login Bridge** in the already-running normal Chromium window.
2. Click **Connect Flow**.
3. In the small Flow app window, click one of the Google accounts already signed into Chromium.

That is the complete account-login flow. Do not enter an email, password, or 2FA code. The normal browser is not closed, restarted, debug-enabled, or modified. Completion is detected automatically, and the isolated Flow session is reused for future generations.

Agents can provide the same onboarding with `flow_connect_account`; users do not need the CLI.

### Reuse an existing Chromium session with CDP

If Chromium was deliberately started with a localhost remote-debugging port, connect directly to that signed-in session:

```powershell
npm run account -- connect personal "Main Chromium" --cdp http://127.0.0.1:9222
```

This advanced mode does not copy or decrypt browser cookies. `flow-mcp` only accepts localhost CDP endpoints and does not close attached browsers. Use the extension mode for normal setup.

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
2. If necessary, tell the user to click the bridge extension, then call `flow_connect_account`; it detects the transfer and existing-account selection automatically.
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

Call `flow_connect_account` again and click a different existing Google account to create another isolated Flow session. Use stable local IDs such as `personal`, `studio`, or `backup`; omit the ID to let the server create one. Email addresses and Google credentials are never required by MCP tools.

Operations for one account are serialized to prevent two agents from changing the same Flow page simultaneously. Separate accounts use separate Chrome contexts and can progress independently.

## Tools

| Tool | Purpose | Spends credits |
| --- | --- | --- |
| `flow_list_accounts` | List local profiles | No |
| `flow_login_bridge_status` | Check whether the localhost bridge is running/waiting | No |
| `flow_connect_account` | Import an existing Chromium Google session and choose an account | No |
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
- The bridge extension has powerful access to Google session cookies. Install only the copy shipped with this repository, review its small source, and never paste or transmit its data elsewhere.
- A browser-session connection can expire or be revoked by Google; click Connect Flow again to refresh it from the normal browser.
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
