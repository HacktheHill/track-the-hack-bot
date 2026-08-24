## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.
## YYYY-MM-DD - [Timing Attack in Token Comparison]
**Vulnerability:** [Session tokens and query parameters were verified using `!==`, exposing the app to timing attacks.]
**Learning:** [Standard string equality checks expose comparison timing, allowing attackers to incrementally forge authentication tokens.]
**Prevention:** [Always use `node:crypto.timingSafeEqual` to verify tokens, secrets, or signatures.]
