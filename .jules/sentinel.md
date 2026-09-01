## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.
## 2024-05-24 - [Denial of Service via Unhandled Crypto Exception]
**Vulnerability:** [Node.js `crypto.timingSafeEqual()` throws an unhandled exception if buffer byte lengths do not match, causing application crash (DoS). `Buffer.from(variable)` can also crash if variable is not a string (e.g. Array via Express HTTP Request Param manipulation).]
**Learning:** [Using regex validation `/^[a-f0-9]{64}$/i.test()` is not robust enough by itself to prevent runtime crashes during crypto operations, especially if the expected hash length changes or if the variable is casted unexpectedly.]
**Prevention:** [Always check variable type and explicitly compare buffer lengths before passing them into `crypto.timingSafeEqual()`.]
