## 2025-02-12 - Prevent Reflected XSS in Express text responses
**Vulnerability:** Reflected XSS vulnerability in Express error handlers and endpoints returning string messages.
**Learning:** Calling `res.send(string)` in Express defaults to setting the `Content-Type` header to `text/html`. If `X-Content-Type-Options: nosniff` is also set (as it was in `src/ai-corpus-server.ts`), the browser will strictly interpret any error message containing user input as HTML, leading to Reflected XSS.
**Prevention:** Always use `res.type('text')` or `res.type('text/plain')` before calling `res.send()` when returning plain text strings, especially in error handlers that might reflect user input or validation errors. Alternatively, use `res.json()` to return a structured JSON response.
