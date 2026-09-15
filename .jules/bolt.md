## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2026-09-15 - Concurrent Proposal Review Card Cleanup
**Learning:** Background jobs that process multiple database rows and perform individual external API calls (e.g., fetching and deleting Discord messages) are prone to significant execution delays if run sequentially with `for...of`. Here, `cleanupTerminalProposalCards` executed sequentially for up to 100 proposals.
**Action:** Always batch or run independent network requests concurrently (e.g., using `Promise.allSettled()`) in background or periodic cleanup tasks to prevent blocking the event loop or slowing down cron jobs, especially when the underlying library (like `discord.js`) already handles rate-limiting.
