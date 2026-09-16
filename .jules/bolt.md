## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2026-09-16 - Optimize member syncing concurrency
**Learning:** discord.js API calls should be batched concurrently with Promise.all or Promise.allSettled to avoid blocking the event loop and speed up application workflows. The library handles rate limiting natively.
**Action:** Always look for opportunities to replace sequential for...of loops containing discord.js API calls with concurrent execution.
