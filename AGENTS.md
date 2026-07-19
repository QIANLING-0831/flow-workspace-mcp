# Google Flow MCP — mandatory installer contract

These instructions apply to any agent asked to install or configure this repository.

## Definition of done

Do not say the MCP is ready merely because the repository was cloned or `npm run build` succeeded. Installation is complete only when:

1. The repository is in a stable, non-scratch directory.
2. The published source is unmodified.
3. `npm ci` and the complete test suite pass.
4. The client uses the repository's absolute `dist/index.js` path through stdio.
5. The client refreshes MCP discovery and exposes `flow_help` and `flow_list_accounts`.
6. The user has loaded the bundled Flow Login Bridge extension.
7. The begin/complete account workflow verifies a connected Flow workspace.

## Supported Antigravity installation

Follow [INSTALL.md](INSTALL.md). From a clean stable clone, run exactly:

```powershell
npm run setup:antigravity
```

The supported installer runs `npm ci`, runs all checks, preserves other MCP entries, creates a backup of the existing config, and writes the official global Antigravity stdio configuration to `~/.gemini/config/mcp_config.json`.

After it succeeds:

1. Tell the user to open **Settings → Customizations → Installed MCP Servers** and click **Refresh**.
2. Tell the user to load the exact `extensionDirectory` printed by the installer through Chromium's **Load unpacked** action.
3. Ask the user to request: **Connect my Google Flow account.**
4. Use `flow_begin_account_connection`. Show its instructions and stop.
5. Wait for the user to click **Connect Flow** in the extension and reply **connected**.
6. Tell the user that a temporary Google chooser will open and they should click their desired existing account.
7. Use `flow_complete_account_connection`.
8. Confirm readiness only after `flow_list_accounts` reports a connected `defaultAccountId`.

## Forbidden installer behavior

- Never install this repository under `.gemini/antigravity/scratch` or another temporary/scratch directory.
- Never edit `src/`, `extension/`, `package.json`, the lockfile, or any other repository source during installation.
- Never run `npx playwright install chromium`; this project intentionally uses a normal installed Chromium or Chrome executable.
- Never generate, copy, or hand-author MCP tool-schema files. Antigravity discovers schemas from the running MCP server after Refresh.
- Never add `--remote-allow-origins=*`, remote-debugging settings, or speculative browser flags.
- Never replace the user's entire `mcp_config.json`; preserve unrelated MCP servers.
- Never use generic browser/computer-use tools to operate the Flow website.
- Never click or ask the user to click Flow's generation-approval choices. The MCP persists and verifies Flow Agent's `AUTO_APPROVE` setting and handles the persistent approval fallback internally.
- Never invoke account completion before the user confirms that the extension popup says the session was sent.

If a hard requirement fails, report the exact failing prerequisite. Do not patch the published source as an installation workaround.

## User capability questions

When the user asks what Flow MCP can do, call `flow_help` and answer in the user's language with concrete examples. Do not answer only with internal tool names.

## Runtime media safety

- Treat the job ID returned by a generation tool as the only authority for later status, upscale, and download operations.
- If generation returns `processing`, poll `flow_job_status` with the same job ID. Never resubmit the prompt just because Flow is queued.
- Never replace `flow_download_job` with a generic browser download or a guessed “latest” gallery item.
- The server tracks the exact asset identities created after each submission. If it returns `job_asset_identity_missing` or `generated_asset_not_found`, report the error and ask the user to regenerate; do not guess an asset.
