## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.

## 2026-09-11 - [Sentinel] Reflected XSS from Default HTML Content-Type in Express
**Vulnerability:** Express defaults to `Content-Type: text/html` when using `res.send(string)`. In `src/ai-corpus-server.ts`, the error handler sends dynamic user-supplied errors (`detail`) without explicitly setting the content type, causing a Reflected XSS vulnerability.
**Learning:** Returning plain strings as error responses in Express is dangerous if not explicitly typed.
**Prevention:** Always use `.type("text")` or `.json()` when returning non-HTML error messages or plain text strings in Express apps.
