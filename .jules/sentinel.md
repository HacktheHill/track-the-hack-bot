## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.

## 2024-10-18 - [Sentinel] Fix Reflected XSS in Express API
**Vulnerability:** Reflected Cross-Site Scripting (XSS) vulnerability due to missing Content-Type headers for plain text responses in Express. `res.send()` defaults to `text/html` which can execute malicious scripts if user input is reflected.
**Learning:** In the project's Express applications, `res.send()` with plain text strings or error messages must explicitly set `res.type('text')` before calling `res.send()`.
**Prevention:** Always use `res.type('text')` before calling `res.send()` with plain text to prevent Reflected XSS. Consider using `.json()` for API endpoints where appropriate as it inherently sets the Content-Type to `application/json`.
