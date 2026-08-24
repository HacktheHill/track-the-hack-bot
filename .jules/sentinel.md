## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.

## 2024-05-18 - [Sentinel] Missing Authorization on /sync Command
**Vulnerability:** The `/sync` command lacked any authorization checks, meaning any user could execute it.
**Learning:** Even though Discord commands are registered with permissions, the code itself should also explicitly check user roles/permissions to implement defense in depth. Failing to do so exposed a denial-of-service vector where a user could repeatedly invoke expensive cross-guild role synchronizations.
**Prevention:** Always verify `interaction.member.roles` or `interaction.member.permissions` explicitly in the interaction handler for administrative or expensive commands.
