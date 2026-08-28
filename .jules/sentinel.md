## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.
## 2025-02-14 - Add Security Headers to Verification Endpoint
**Vulnerability:** Missing security headers on the verification Express endpoint (`/verify`).
**Learning:** This existed because standard Express apps don't set security headers by default. Attackers could potentially frame the endpoint, execute content sniffing, or execute other client-side attacks if content was returned to a browser.
**Prevention:** Always add a middleware (or use a library like `helmet`) to configure basic defense-in-depth security headers for web server endpoints, even if they're intended primarily for API consumption.
