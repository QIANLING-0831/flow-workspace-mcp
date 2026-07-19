# Changelog

All notable changes to Google Flow MCP are documented here.

## [0.1.0] - 2026-07-19

### Added

- Local stdio MCP server with nine Flow tools
- Flow Login Bridge extension for reusing existing Chromium Google accounts
- Isolated persistent sessions and queues for multiple accounts
- Live, language-independent model, ratio, output-count, duration, and asset-option discovery
- Normalized IDs for Omni Flash, Veo, and Nano Banana model families
- Credit-confirmation gates for generation and upscaling
- Persistent generation jobs with status polling
- Structural detection of preview, original, available upscale, and unavailable/upgrade-only choices
- Browser download capture with `.flow.json` manifests, SHA-256, and optional FFprobe metadata
- Codex, Antigravity, generic MCP, and Remotion documentation
- Windows/Linux CI across Node.js 20 and 24

### Live validation

- Existing-account connection from normal Chromium
- Spanish-language Flow capability discovery
- Real Omni Flash 16:9 video generation
- Persistent queue polling and original-resolution video download
- H.264, duration, and resolution validation through FFprobe

### Known limitations

- Google Flow UI automation can require selector updates when the website changes
- Browser extension installation currently uses developer-mode “Load unpacked” setup
- Live image, reference-file, upscale-download, macOS/Linux browser, and multi-account concurrency paths need broader opt-in validation

[0.1.0]: https://github.com/retrolyze52/google-flow-mcp/releases/tag/v0.1.0
