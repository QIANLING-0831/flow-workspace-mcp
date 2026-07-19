# Install Google Flow MCP

This is the supported installation and first-run procedure. Installer agents must follow it without modifying repository source.

## Requirements

- Node.js 20 or newer
- Git
- A normal desktop Chromium or Google Chrome installation
- A Google account with Flow access
- The Google account already signed into the normal Chromium profile you intend to use

Do not install Playwright's bundled Chromium. Do not start the normal browser with remote debugging. Do not place the repository in a scratch directory.

## Antigravity: clean installation

Antigravity's official MCP documentation uses `~/.gemini/config/mcp_config.json` for global custom servers and supports `command`, `args`, `env`, and `cwd` for local stdio processes. The installer below writes that structure while preserving existing servers.

### 1. Clone into a stable directory

Windows PowerShell:

```powershell
git clone https://github.com/retrolyze52/google-flow-mcp.git "$env:LOCALAPPDATA\google-flow-mcp"
Set-Location "$env:LOCALAPPDATA\google-flow-mcp"
```

macOS/Linux:

```bash
git clone https://github.com/retrolyze52/google-flow-mcp.git "$HOME/.local/share/google-flow-mcp"
cd "$HOME/.local/share/google-flow-mcp"
```

### 2. Run the supported installer

```powershell
npm run setup:antigravity
```

The installer refuses disposable Antigravity scratch paths and modified tracked source. It then:

1. Detects Node.js and a normal system Chromium/Chrome browser.
2. Runs `npm ci`.
3. Runs TypeScript checks and every automated test.
4. Builds `dist/index.js`.
5. Backs up the existing MCP config to `mcp_config.json.bak`.
6. Adds only the `google-flow` stdio entry using absolute paths.
7. Prints the exact extension directory and remaining user steps.

### 3. Refresh Antigravity

In Antigravity:

1. Open **Settings**.
2. Open **Customizations**.
3. Find **Installed MCP Servers**.
4. Click **Refresh**.
5. Confirm `google-flow` is enabled and no error is shown.

Antigravity discovers all MCP tool schemas automatically. Do not generate schema files.

### 4. Load Flow Login Bridge once

In the normal Chromium browser where your Google accounts are already signed in:

1. Open `chrome://extensions/`.
2. If Flow Login Bridge is already loaded from a different folder, remove that old extension entry first.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `extensionDirectory` printed by the installer, for example:

   `C:\Users\YOU\AppData\Local\google-flow-mcp\extension`

6. Pin **Flow Login Bridge** so it is easy to open.

No browser restart, password entry, 2FA entry, cookie export, or remote-debugging launch is required.

### 5. Connect an existing Google account

Tell the agent:

> Connect my Google Flow account.

The correct interaction is deliberately split so the agent cannot hide the user action inside a long-running tool call:

1. The agent calls `flow_begin_account_connection`.
2. The agent tells you to open **Flow Login Bridge** in normal Chromium and click **Connect Flow**.
3. The extension displays **Session sent**. Return to the agent and reply **connected**.
4. The agent tells you that a temporary Google chooser will open, then calls `flow_complete_account_connection`.
5. Click the desired account already shown in Google's chooser.
6. Flow workspace access is verified automatically and the temporary window closes.
7. `flow_list_accounts` must report that account as `connected` and as `defaultAccountId`.

If the public Flow marketing page appears instead of the workspace, the MCP returns `flow_access_unavailable`; the agent must not scroll or automate that page.

## Verify the installation

Ask:

> What can I do with Flow MCP?

The agent should call `flow_help` and explain capabilities with examples such as:

- “Create one 16:9 Omni Flash video and save it in my project.”
- “Generate a vertical image with Nano Banana 2 using this reference.”
- “Tell me which Flow models, ratios, durations, output counts, and upscales I have.”
- “Upscale the last video to the highest option my account offers.”
- “Download the clip into my Remotion project.”

Then run a read-only account check:

> List my connected Flow accounts and inspect the default account's live options.

## Other MCP clients

For any local stdio MCP client, run `npm ci` and `npm run check`, then configure:

```json
{
  "mcpServers": {
    "google-flow": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/google-flow-mcp/dist/index.js"],
      "cwd": "/absolute/path/to/google-flow-mcp",
      "env": {
        "FLOW_MCP_HEADLESS": "0"
      }
    }
  }
}
```

Refresh or restart only the MCP client so it discovers the server. Chromium does not need to restart.

## Updating

From the stable clone:

```powershell
git pull --ff-only
npm run setup:antigravity
```

The installer reruns all checks and updates only the `google-flow` MCP entry.

Official Antigravity reference: [Model Context Protocol (MCP)](https://antigravity.google/docs/mcp).
