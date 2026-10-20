## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2024-10-20 - Consolidate UPDATE/INSERT into CTE for PostgreSQL

**Learning:** When executing batched queries (like an `UPDATE ... RETURNING` followed by an `INSERT` using those results), using manual transaction management (`BEGIN` + `COMMIT`) in node-postgres causes additional network roundtrips and connection pool overhead. This pattern often leads to bottlenecks.
**Action:** Use a single Common Table Expression (CTE) string (e.g. `WITH updated AS (...) INSERT ... FROM updated`) within a single `pool.query()` statement. This ensures the operations are inherently atomic, removes the need for explicit transactions, and reduces connection overhead.
