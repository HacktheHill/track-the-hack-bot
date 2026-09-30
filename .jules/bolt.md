## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2024-05-30 - [Combine Updates and Inserts with CTEs]
**Learning:** Performing a bulk update and inserting corresponding log records using a loop causes an N+1 query performance bottleneck. PostgreSQL Common Table Expressions (CTEs) can perfectly solve this.
**Action:** Use a `WITH updated AS (UPDATE ... RETURNING ...) INSERT INTO ... SELECT ... FROM updated` pattern to execute the entire batch update and subsequent audit logging in a single database roundtrip.
