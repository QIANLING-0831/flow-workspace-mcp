# Security

## Account data

`flow-mcp` never asks for or stores Google passwords or 2FA codes. The Flow Login Bridge reads Google cookies only after a user click and transfers them over localhost to the running MCP process. Raw transfer payloads remain in memory and are never logged or written as JSON. Chromium persists the resulting isolated Flow session under the platform application-data directory. Optional CDP attachment is restricted to localhost endpoints.

The localhost bridge rejects normal web origins, validates Google-only cookie domains, limits payload size, and listens only on `127.0.0.1`. Install only a reviewed copy of the bundled extension; any extension with cookie permission is security-sensitive.

Do not commit a directory supplied through `FLOW_MCP_DATA_DIR`. Treat copied browser profiles as credentials.

## Reporting a vulnerability

Please open a private GitHub security advisory rather than a public issue. Include reproduction steps, affected versions, and the smallest practical proof of concept. Do not include real cookies, account identifiers, prompts, or generated private media.

## Automation boundary

This project automates visible controls in a user-owned browser session. It intentionally does not bypass CAPTCHA, account verification, access controls, quotas, regional restrictions, or safety policies.
