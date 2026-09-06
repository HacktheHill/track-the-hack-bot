## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.

## 2025-02-14 - Prevent Reflected XSS in Express Error Responses
**Vulnerability:** Express `response.send()` was used to return user-controlled error message strings without explicitly setting a content type. This could allow an attacker to inject HTML/JS payloads if the error details include reflected user input, causing Express to render it as HTML.
**Learning:** By default, Express attempts to determine the `Content-Type` from the payload type and context. If a raw string is passed, it might be interpreted differently or fall back to an unsafe default, making XSS possible when logging/returning dynamic Zod validation or system errors.
**Prevention:** Always explicitly call `response.type('text')` before `.send()` when returning plain text, especially for error responses that include dynamic data or exceptions.
