## 2023-10-27 - [Sentinel] Input Validation and Replay DoS Mitigation in Verification API
**Vulnerability:** The `/verify` API endpoint lacked input validation for `req.body.discordId`, and was vulnerable to log spam / DoS via replay attacks because it did not check if the user was already verified before acting and logging to Discord.
**Learning:** The Express integration using `bodyParser.json()` parses input aggressively. If an empty payload is sent, it can lead to `undefined` discordId which fetches the entire Discord guild if unhandled.
**Prevention:** Always validate API input types, enforce idempotency checks to prevent redundant costly API requests, and add basic security headers like `app.disable("x-powered-by")`.
## 2025-02-27 - [Sentinel] Timing Attack Vulnerability in Corpus API Token Validation
**Vulnerability:** The AI Corpus UI Express app (`src/ai-corpus-server.ts`) validated access tokens using strict equality (`!==`), exposing the endpoint to timing attacks that could allow attackers to guess the token character by character.
**Learning:** `!==` string comparison exits early when characters don't match, creating a measurable time difference based on how many characters match the secret. `crypto.timingSafeEqual` must be used for sensitive tokens, but requires length checks first to avoid throwing TypeErrors.
**Prevention:** Use `crypto.timingSafeEqual` for all secret comparisons, and always wrap it in a helper function to safely handle type and length checks first.
