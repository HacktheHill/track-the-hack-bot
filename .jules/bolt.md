## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2024-10-13 - PostgreSQL Batched Transaction N+1 Query Elimination
**Learning:** Performing `UPDATE ... RETURNING` in PostgreSQL inside a `BEGIN`/`COMMIT` transaction, and then executing multiple subsequent `INSERT` queries from the result set, results in a database round-trip bottleneck (N+1 query problem) that increases latency. A single statement is inherently atomic, so the explicit transaction blocks can be eliminated.
**Action:** When combining `UPDATE` operations and subsequent `INSERT`s, use Common Table Expressions (CTEs) like `WITH updated AS (...) INSERT ... SELECT ... FROM updated` to process everything in a single database round-trip.
