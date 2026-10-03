# Google Flow / Veo API evidence

Reviewed 2026-10-02. Only first-party Google documentation is used below.

## Public API boundary

Google documents Flow as its filmmaking application, with access through a Chromium browser and Google AI subscription entitlements. The reviewed Flow Help index, onboarding, model documentation, and official announcements do **not** publish a Flow generation API reference, developer authentication contract, or stable REST endpoint schema. This is a bounded research finding, not proof that no internal API exists. [Flow onboarding](https://support.google.com/flow/answer/16353333?co=GENIE.Platform%3DDesktop&hl=en), [Flow Help](https://support.google.com/flow/?hl=en).

Google does publish programmatic **Veo generation through the Gemini API**, with model IDs and video parameters. Google separately names Flow, Gemini API, and Vertex AI as access surfaces; sharing a model does not make their endpoints or entitlements interchangeable. [Veo developer guide](https://ai.google.dev/gemini-api/docs/veo), [Google announcement](https://blog.google/innovation-and-ai/products/veo-updates-flow/).

## Billing and credits

Flow uses account-level Flow/AI credits; generation costs depend on its selected model and are charged per generation, including when one request produces multiple outputs. Current costs can change and should be checked in Flow's model settings. [Flow credits](https://support.google.com/flow/answer/16526234?hl=en).

Gemini API uses project/API-key credentials and Cloud Billing accounts. Its published Veo pricing is paid-tier metering per second, and the free tier is unavailable for Veo. Therefore a Gemini/Veo API fallback is a separately billed integration; the reviewed docs provide no contract for spending a consumer Flow subscription balance through a Gemini API key. [API billing](https://ai.google.dev/gemini-api/docs/billing), [Veo pricing](https://ai.google.dev/gemini-api/docs/pricing).

## Errors: keep each surface distinct

Flow Help documents upload/generation failures, safety blocks, processing issues, and partial output notifications, but the reviewed pages do not define a machine-readable Flow backend error catalog. The onboarding FAQ says failed Flow generations are not charged; disputed credit charges should go to Google One support. [Flow error notifications](https://support.google.com/flow/answer/16353335?co=GENIE.Platform%3DAndroid&hl=en), [Flow FAQ](https://support.google.com/flow/answer/16353333?co=GENIE.Platform%3DDesktop&hl=en).

Gemini's troubleshooting guide advises bounded exponential backoff with jitter for transient errors such as 429, 408, and 5xx, and no blind retries for 400, 402, or 403. These recommendations apply to Gemini API, not automatically to private Flow requests. [Gemini troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting).

The linked API errors page explicitly describes **Interactions API** codes: examples include `authentication` (401), `payment_required` (402), `permission_denied` (403), `rate_limit_exceeded` / `quota_exceeded` (429), `api_error` (500), and `service_unavailable` (503). Do not copy that schema into Flow or assume it is the Veo generation response contract. [Interactions API errors](https://ai.google.dev/gemini-api/docs/api-errors).

## Private Flow interface unknowns

Observed private endpoint names, browser request fields, bearer-token lifetime, project ownership rules, reCAPTCHA requirements, error strings, retry safety, and credit accounting remain undocumented by the reviewed public sources. A 403 or 429 alone cannot establish whether a private Flow request failed because of subscription access, authentication, captcha validation, policy, or quota. Preserve sanitized HTTP status and structured response details for diagnosis; label any proposed mapping as an observation or hypothesis rather than official behavior.

## Local first-party protocol observations (2026-10-02)

These are observations of this user's authenticated Flow session and Google's served client, **not a supported API contract**. Client build observed: `AiSandboxAngularFrontend.en.SE3VK6s4aGU.2018.O` on [Google Flow](https://flow.google.com/).

- `mrlkwd` is registered as `FlowCreationAgentService.ListSessions`; `GN0Bre` as `GetSession`. Independently constructed read RPCs returned the stored session and structured `generate_video_from_text` tool result for an exact historical prompt: `status: error`, `error_code: PUBLIC_ERROR_USER_QUOTA_REACHED`.
- Google's current client groups user quota, per-model daily quota, upgradeable per-model daily quota, and workspace-account quota together. These four explicit codes are recognized; `PUBLIC_ERROR_USER_REQUESTS_THROTTLED` is not quota fallback. Only user quota was observed in a real failed task; the other mappings are client-source evidence plus tests, not live failures.
- `nzlxg` is registered as `VideoFxService.GetCredits`. In the two observed accounts, positions 0 and 5 agreed with previously verified UI balances, 3 and 29. Position 1 differed for the second account and must not be treated as its remaining credits. Unknown/disagreeing layouts return unknown, not zero. No daily-free balance is inferred.
- Historical quota and balance reads used an isolated HTTP context borrowing existing session cookies in memory. They did not navigate the page or submit generation. The read probe also confirmed that a baseline covering existing turns excludes the old failure.
- Routing requires a conversation-turn baseline saved **before submission**, then a unique exact prompt in newly appended turns. Legacy jobs without this baseline do not gain automatic backend routing from historical text. RPC/schema/read failures retain the existing UI fallback; storage-write failures propagate.
- Client source registers `FlowCreationAgentService.StreamChat` (`xNyCid`) and video text generation (`YhhmEf`). The ordinary chat client obtains a verification token for `CHAT_GENERATION` before streaming. Endpoint names do not prove that a browserless request can be submitted safely or successfully.

Generation submission is **not migrated to HTTP** in this change. The new live generation probes stopped before submission in the existing UI setup/project path; no generation request was captured and no new video was produced. Login remains browser-backed. The verified backend scope is balance/quota reads and original-media downloads. See [read-only probe](../scripts/probe-flow-quota-api.mjs) and [validation record](VALIDATION.md).
