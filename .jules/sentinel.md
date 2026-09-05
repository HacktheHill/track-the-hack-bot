## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.

## 2026-09-05 - [Sentinel] Explicit Content-Type in Express Plain Text Error Responses
**Vulnerability:** Express `res.send()` can automatically infer content-type (e.g. text/html) when passing plain text / error strings to it. If user input like an error string or detail is reflected back unescaped, it results in a Reflected XSS vulnerability.
**Learning:** Express's default behavior tries to be smart but can introduce XSS when throwing dynamic error strings in `res.send()`.
**Prevention:** In Express applications, explicitly set `res.type('text')` before calling `res.send()` with plain text strings or error messages to prevent Reflected XSS.
