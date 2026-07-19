<div align="center">

# Google Flow MCP

**Generate and download Google Flow videos and images directly from AI agents—using your existing Google subscription, with no generation API key.**

[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-compatible-7c3aed)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: Alpha](https://img.shields.io/badge/status-alpha-orange)](#project-status)

Works with **OpenAI Codex**, **Google Antigravity**, and other local stdio MCP clients.

[Features](#why-google-flow-mcp) · [Quick start](#quick-start) · [Connect an account](#connect-your-google-account) · [Clients](#connect-your-mcp-client) · [Tools](#mcp-tools) · [Security](#security)

</div>

---

Google Flow MCP is a local [Model Context Protocol](https://modelcontextprotocol.io/) server that lets an AI agent operate [Google Flow](https://labs.google/fx/tools/flow) through a user-owned Chromium session. It can discover the exact options available to each account, generate media with Flow subscription credits, wait for long-running jobs, use the upscale choices Flow actually offers, and save validated files directly into a project.

It does **not** require a Google generation API key. Credits are consumed through the Flow website just as they are when the user operates Flow manually.

## Why Google Flow MCP

### The agent knows what the account can actually do

`flow_inspect_account` returns a live, normalized capability contract instead of relying on hardcoded assumptions:

- Image and video models, with stable IDs and the currently selected model
- Aspect ratios separated by media type
- Output counts separated by media type
- Selectable durations—only when Flow exposes a duration control
- Preview, original, available upscale, and unavailable/upgrade-only asset options
- Current Flow UI language and login state

Example from a real Spanish-language Flow account:

```json
{
  "models": {
    "image": [
      { "id": "nano-banana-pro", "label": "Nano Banana Pro", "selected": false },
      { "id": "nano-banana-2", "label": "Nano Banana 2", "selected": true },
      { "id": "nano-banana-2-lite", "label": "Nano Banana 2 Lite", "selected": false }
    ],
    "video": [
      { "id": "omni-flash", "label": "Omni Flash", "selected": true },
      { "id": "veo-3-1-lite", "label": "Veo 3.1 - Lite", "selected": false },
      { "id": "veo-3-1-fast", "label": "Veo 3.1 - Fast", "selected": false },
      { "id": "veo-3-1-quality", "label": "Veo 3.1 - Quality", "selected": false }
    ]
  },
  "aspectRatiosByMedia": {
    "image": ["16:9", "4:3", "1:1", "3:4", "9:16"],
    "video": ["16:9", "9:16"]
  },
  "outputCountsByMedia": {
    "image": [1, 2, 3, 4],
    "video": [1, 2, 3, 4]
  },
  "visibleDurations": [],
  "availableUpscales": ["1080p"],
  "unavailableUpscales": ["4k"]
}
```

If Flow does not offer a requested model, ratio, duration, output count, or upscale, the MCP fails explicitly. It never silently substitutes a different paid option.

### Account connection without entering credentials again

The bundled **Flow Login Bridge** extension reuses Google accounts already signed into the user's normal Chromium profile:

1. The user clicks **Connect Flow** in the extension.
2. Google displays the existing-account chooser in a temporary Flow window.
3. The user clicks an account they already use.
4. The temporary window closes after connection; future automation runs in an isolated persistent session.

No email entry, password entry, 2FA entry, cookie JSON, Chromium restart, or remote-debugging launch is required for the normal login path.

### End-to-end media delivery

- Generates video with Omni Flash or the Veo models exposed by the account
- Generates or edits images with the Nano Banana models exposed by the account
- Accepts prompts in any language
- Supports ratios, output counts, optional references, and durations when available
- Persists jobs that outlive an MCP request timeout
- Detects Flow's real asset-menu upscale choices, including resolution-based options such as `1080p`
- Captures browser downloads into an absolute project directory
- Writes a `.flow.json` reproducibility manifest
- Records SHA-256 and file size for every download
- Adds duration, dimensions, codec, and format when `ffprobe` is installed
- Saves diagnostic screenshots when Flow's UI changes

### Designed for agents without hiding credit use

Generation and upscale tools require `confirmCreditSpend: true`. The agent should set it only after the user explicitly asks for a credit-consuming operation. Read-only inspection, status, and account-list tools do not spend credits.

## Quick start

### Requirements

- Node.js 20 or newer
- Chromium or Google Chrome
- A Google account with access to Flow in a supported region
- Optional: `ffprobe` on `PATH` for richer media validation

### Install

```powershell
git clone https://github.com/retrolyze52/google-flow-mcp.git
cd google-flow-mcp
npm ci
npm run build
```

Playwright controls the locally installed Chromium/Chrome executable; it does not require a separate bundled browser download. Set `FLOW_MCP_BROWSER_EXECUTABLE` to an absolute browser path only if auto-detection cannot find it.

## Connect your Google account

### 1. Install the Flow Login Bridge once

The reviewed extension source is included in [`extension/`](extension/). It reads Google cookies only after the user clicks **Connect Flow** and sends them only to the MCP bridge bound to `127.0.0.1`. It never reads passwords or 2FA codes.

On Windows with Chromium:

```powershell
npm run install-extension
```

The helper copies the extension path and opens `chrome://extensions/`. Then:

1. Enable **Developer mode**.
2. Click **Load unpacked**.
3. Select the repository's `extension` directory.

For Chrome or another desktop platform, open `chrome://extensions/` manually and follow the same three steps. No browser restart is needed.

### 2. Start connection from the agent

Ask the agent:

> Connect my Google Flow account as `personal`.

The agent calls `flow_connect_account` and waits. While it is waiting:

1. Open **Flow Login Bridge** in the already-running normal browser.
2. Click **Connect Flow**.
3. Click one of the Google accounts shown in the temporary chooser.

That is the complete normal login flow. Completion is detected automatically and the temporary Flow window closes.

To connect additional accounts, repeat the process with IDs such as `studio` or `backup`. Each account receives an isolated persistent browser profile. Operations for one account are serialized; separate accounts can progress independently.

CLI equivalents are also available:

```powershell
npm run account -- connect personal "Personal Google Pro"
npm run account -- connect studio "Studio account"
npm run account -- list
```

### Advanced: attach to localhost CDP

If a browser was deliberately started with a localhost remote-debugging port, the MCP can attach without copying cookies:

```powershell
npm run account -- connect personal "Main Chromium" --cdp http://127.0.0.1:9222
```

Only localhost CDP endpoints are accepted, and attached browsers are never closed by the MCP. The extension flow is recommended for normal setup.

## Connect your MCP client

Run `npm run build` first. Replace the paths below with the absolute location of `dist/index.js`.

### OpenAI Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.google_flow]
command = "node"
args = ["C:\\absolute\\path\\to\\google-flow-mcp\\dist\\index.js"]
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 1200

[mcp_servers.google_flow.env]
FLOW_MCP_HEADLESS = "0"
```

Open a new Codex task after changing MCP configuration. This does not restart Chromium or require another Google login.

### Google Antigravity

Antigravity 2.0, Antigravity IDE, and Antigravity CLI support custom MCP servers. Open **MCP Servers → Manage MCP Servers → View raw config**, or edit the shared `~/.gemini/config/mcp_config.json`, and add:

```json
{
  "mcpServers": {
    "google-flow": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\google-flow-mcp\\dist\\index.js"],
      "env": {
        "FLOW_MCP_HEADLESS": "0"
      }
    }
  }
}
```

Then open **Settings → Customizations → Installed MCP Servers** and click **Refresh**. In Antigravity CLI, use `/mcp` to inspect the server and its tools. See Google's [Antigravity MCP configuration guide](https://codelabs.developers.google.com/google-workspace-mcp-antigravity).

### Other stdio MCP clients

```json
{
  "mcpServers": {
    "google-flow": {
      "command": "node",
      "args": ["/absolute/path/to/google-flow-mcp/dist/index.js"]
    }
  }
}
```

## Example agent requests

Once the account is connected, users can speak normally:

> Inspect my Flow account and tell me exactly which image models, video models, ratios, durations, output counts, and upscales are available.

> Use Omni Flash to create one 16:9 video of a translucent glass jellyfish floating through a rainy neon city. Download it into `public/generated/flow`. Do not upscale it.

> Generate a vertical image with Nano Banana 2 Lite using the attached reference image and save it for my Remotion project.

> Upscale the last video to the highest resolution my account actually offers. Do not choose an unavailable or upgrade-only option.

The expected agent workflow is:

1. `flow_list_accounts`
2. `flow_connect_account` when necessary
3. `flow_inspect_account` immediately before generation
4. `flow_generate_video` or `flow_generate_image` after explicit authorization
5. `flow_job_status` for long-running work
6. `flow_upscale_video` when requested
7. `flow_download_job` for a ready asset that has not yet been downloaded

Example video tool input:

```json
{
  "accountId": "personal",
  "prompt": "A cinematic tracking shot through a rainy miniature neon city, shallow depth of field, reflections on wet streets, no text",
  "model": "omni-flash",
  "aspectRatio": "16:9",
  "outputs": 1,
  "referenceFiles": [],
  "upscale": "none",
  "outputDirectory": "C:\\projects\\my-remotion-video\\public\\generated\\flow",
  "download": true,
  "timeoutSeconds": 600,
  "confirmCreditSpend": true
}
```

For Remotion, files saved under `public/generated/flow` can be loaded with `staticFile("generated/flow/<file>.mp4")`.

## Upscaling

Upscaling is a real Flow asset action, not local interpolation:

1. The MCP opens the generated asset's context menu.
2. It reads factor or resolution choices structurally, independently of translated surrounding text.
3. It distinguishes previews, originals, available upscales, and disabled/upgrade-only choices.
4. Exact requests such as `2x` or `1080p` fail if that exact option is unavailable.
5. `highest_available` ranks only options Flow currently offers.
6. The MCP captures either the direct upscaled download or a newly processing asset.

The MCP never invents `4x`, silently downgrades a request, or substitutes an unrelated local upscaler.

## MCP tools

| Tool | Purpose | Spends credits |
| --- | --- | ---: |
| `flow_list_accounts` | List locally configured account profiles | No |
| `flow_login_bridge_status` | Check the localhost login bridge | No |
| `flow_connect_account` | Connect an existing Chromium Google session | No |
| `flow_inspect_account` | Return the live normalized capability map | No |
| `flow_generate_video` | Generate, optionally upscale, and download video | Yes |
| `flow_generate_image` | Generate/edit and download an image | Potentially |
| `flow_job_status` | Poll a persistent job | No |
| `flow_upscale_video` | Request an exact live upscale option | Potentially |
| `flow_download_job` | Download an already-created asset | No new generation |

Every tool includes MCP-visible parameter descriptions so the agent knows how to use the live IDs returned by `flow_inspect_account`.

## Runtime data and diagnostics

Runtime state stays outside the repository by default:

- Windows: `%LOCALAPPDATA%\flow-mcp`
- macOS: `~/Library/Application Support/flow-mcp`
- Linux: `$XDG_DATA_HOME/flow-mcp` or `~/.local/share/flow-mcp`

```text
flow-mcp/
  accounts.json
  profiles/<account-id>/
  jobs/<job-id>.json
  diagnostics/*.png
```

Override the location with `FLOW_MCP_DATA_DIR`. Never commit that directory. If Flow changes its UI, errors include a diagnostic screenshot where possible; selectors intentionally prefer semantic roles and stable Material Symbols over translated text or hashed CSS classes.

## Security

- The login bridge binds only to `127.0.0.1` on a small fixed port range.
- Normal web origins are rejected; extension requests and cookie payloads are validated.
- Only Google-domain cookies are accepted.
- Session-transfer payloads are held in memory briefly and are never sent to a remote service by this project.
- Passwords and 2FA codes are never accessed.
- Generation and upscale tools require an explicit credit-spend confirmation argument.
- CAPTCHA, verification, regional restrictions, quotas, safety filters, and access controls are not bypassed.

The extension necessarily has powerful access to Google cookies. Install only a reviewed copy from this repository. See [SECURITY.md](SECURITY.md) for the threat model and responsible disclosure process.

## Project status

**Alpha.** The core workflow has been live-tested with an existing Chromium account, a Spanish Flow interface, live model/ratio/upscale discovery, one real Omni Flash generation, persistent polling, browser download capture, and FFprobe validation.

Google Flow does not provide a stable public browser-automation contract. UI changes can break selectors even with structural discovery and defensive failure behavior. Live Google-account tests are intentionally excluded from CI because they would require private sessions and spend credits.

Current priorities:

- Publish the login bridge through a browser extension store
- Split the large Flow adapter into smaller capability, generation, and asset modules
- Expand opt-in live tests for images, references, upscaling, and multiple accounts
- Add macOS/Linux onboarding helpers

## Development

```powershell
npm ci
npm run typecheck
npm test
npm run check
npm pack --dry-run
```

The included CI workflow targets Windows and Linux with Node.js 20 and 24. Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License and disclaimer

[MIT](LICENSE). This is an independent, clean-room project. It is not affiliated with, endorsed by, or supported by Google. Google Flow, Gemini, Veo, Nano Banana, Omni, Chromium, Codex, Antigravity, and Remotion are trademarks or products of their respective owners.

Use this project in accordance with Google's terms and all applicable policies.
