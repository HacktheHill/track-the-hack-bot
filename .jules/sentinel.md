## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.
## 2024-05-18 - Prevent Reflected XSS in Express API Responses
**Vulnerability:** Express `res.send()` can default to `text/html` when returning plain strings (like error details), leading to Reflected XSS if an error message reflects untrusted user input without sanitization.
**Learning:** Returning static strings or `Error.message` strings directly via `res.send()` is unsafe in Express without explicit content-type specification.
**Prevention:** Always set explicit content types using `res.type('text')` before `res.send()` for plain text responses and error messages.
