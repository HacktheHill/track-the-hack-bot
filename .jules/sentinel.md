## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.
## 2025-02-14 - Webhook Signature Verification

**Vulnerability:** Webhook signature verification used `JSON.stringify(req.body)` to compute the HMAC signed payload.
**Learning:** Using `bodyParser.json()` parses the raw request stream into a JavaScript object. `JSON.stringify()` on this object can change the exact text representation (due to spacing, property order, etc.) that the remote server used to generate the signature, causing false signature verification failures or potentially obscuring manipulation.
**Prevention:** Use `express.json({ verify: (req, res, buf) => { req.rawBody = buf; } })` to capture the raw, unmodified request buffer and use it directly for computing the signature payload.
