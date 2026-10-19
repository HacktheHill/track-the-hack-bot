## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.

## 2025-02-12 - Prevent Connection Overhead Using CTEs
**Learning:** In `node-postgres`, managing explicit `BEGIN`, `COMMIT`, and `ROLLBACK` transitions for multiple statements requires keeping a connection checked out and incurs multiple database roundtrips. This causes N+1 query bottlenecks during batched transaction contexts.
**Action:** When performing batched or dependent queries (like `UPDATE ... RETURNING` and a subsequent `INSERT`), use Common Table Expressions (CTEs) within a single `pool.query()` statement. Since a single query is inherently atomic in PostgreSQL, this eliminates explicit transaction management and connection contention.
