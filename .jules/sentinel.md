## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.
## 2023-10-27 - [Sentinel] Reflected XSS in Express text responses
**Vulnerability:** Express `res.send(string)` defaults to `Content-Type: text/html`. When an error message containing unsanitized input is passed to `res.send()`, it can result in a Reflected XSS vulnerability because the browser interprets it as HTML.
**Learning:** In `src/ai-corpus-server.ts`, error handlers and early returns were using `res.send("...")` which could reflect user-controlled data (like error messages) as HTML.
**Prevention:** Always explicitly set `res.type("text")` before `res.send()` when returning plain text strings to ensure the browser treats it as `text/plain`.
