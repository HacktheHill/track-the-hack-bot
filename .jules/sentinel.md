## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.

## 2024-05-18 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked proper request body validation for HMAC signature computation. It calculated the payload using `JSON.stringify(req.body)`, which is vulnerable to differences in spacing from the original payload.
**Learning:** `bodyParser.json()` parses the original payload and drops all formatting characters. When `JSON.stringify` recreates the string, any difference in formatting will make the signature validation fail for valid payloads or provide a potential attack vector for mutated payloads.
**Prevention:** Compute signatures using the exact `rawBody` byte string from the original HTTP request by leveraging the `verify` option in `bodyParser.json()`.
