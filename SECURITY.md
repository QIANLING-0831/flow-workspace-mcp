# Security

## Account data

`flow-mcp` never asks for or stores Google passwords. Each managed account uses an isolated Chromium user-data directory under the platform application-data directory. Cookies and other browser state stay in that directory and are not part of the repository. Optional CDP attachment is restricted to localhost endpoints.

Do not commit a directory supplied through `FLOW_MCP_DATA_DIR`. Treat copied browser profiles as credentials.

## Reporting a vulnerability

Please open a private GitHub security advisory rather than a public issue. Include reproduction steps, affected versions, and the smallest practical proof of concept. Do not include real cookies, account identifiers, prompts, or generated private media.

## Automation boundary

This project automates visible controls in a user-owned browser session. It intentionally does not bypass CAPTCHA, account verification, access controls, quotas, regional restrictions, or safety policies.
