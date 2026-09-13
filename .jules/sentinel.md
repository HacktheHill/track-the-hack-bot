## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.

## 2024-05-18 - Prevent Express Reflected XSS from implicit text/html Content-Type
**Vulnerability:** Express apps were using `res.send("plain text message")`. If "plain text message" contained user input (like a zod error detail), Express would infer `text/html` and browsers would execute any HTML/scripts within the text.
**Learning:** Calling `res.send()` with a string defaults to `text/html` in Express unless explicitly set otherwise. User inputs or error messages sent directly to `res.send()` can trigger Reflected XSS.
**Prevention:** Always explicitly set `res.type('text')` (or `res.set('Content-Type', 'text/plain')`) before returning a plain text response via `res.send()`.
