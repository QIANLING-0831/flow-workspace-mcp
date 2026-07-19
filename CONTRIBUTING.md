# Contributing

Contributions are welcome, especially fixes for Flow UI changes, browser compatibility, accessibility, tests, and documentation.

## Development setup

```powershell
npm ci
npm run check
```

Node.js 20 or newer is required. The included CI matrix targets Windows and Linux with Node.js 20 and 24.

## Pull requests

1. Keep changes focused and explain the user-visible behavior.
2. Add or update tests for pure parsing, validation, persistence, and MCP schemas.
3. Run `npm run check` and `npm pack --dry-run`.
4. Do not commit Flow profiles, cookies, generated account data, diagnostics, `.env` files, or personal output.
5. Prefer semantic roles, stable attributes, and Material Symbol names over translated text and hashed CSS classes.
6. State whether a Flow interaction was live-tested and whether it consumed credits.

## Live testing

Live tests require a user-owned Google account and may spend subscription credits. Never add live credentials to CI. Credit-consuming tests must be opt-in and clearly disclose their expected cost before execution.

## UI-change reports

When reporting a broken selector, include the Flow locale, media type, intended model, and a redacted diagnostic screenshot. Remove email addresses, avatars, project names, prompts, cookies, and other personal information.
