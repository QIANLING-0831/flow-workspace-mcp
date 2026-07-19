# Security policy

## Supported versions

Google Flow MCP is currently an alpha release. Security fixes are applied to the latest commit on `main`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. Do not open a public issue containing session cookies, browser profile data, diagnostic screenshots with account information, or a working exploit.

Include:

- A concise description of the impact
- Reproduction steps using a test account where possible
- Affected operating system and browser
- The relevant commit or version
- Any suggested mitigation

## Threat model

The Flow Login Bridge extension has permission to read Google-domain cookies after a user clicks **Connect Flow**. This is sensitive access. The current design reduces exposure by:

- Binding the receiver only to `127.0.0.1`
- Restricting the receiver to a small fixed port range
- Rejecting normal web origins
- Validating cookie domains, sizes, count, and payload size
- Holding an unclaimed transfer in memory for at most two minutes
- Importing the session into a local isolated Chromium profile
- Never transmitting the session to a remote service operated by this project

The isolated Chromium profile and its cookies remain sensitive local data. Protect the operating-system account, do not sync or commit the runtime data directory, and reconnect the account if the browser session is revoked.

## Explicit non-goals

This project does not bypass CAPTCHA, Google verification, safety filters, quotas, subscription requirements, regional restrictions, or account access controls. It is not an official Google API or security boundary.
