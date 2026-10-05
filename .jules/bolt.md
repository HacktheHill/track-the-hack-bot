## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2026-10-05 - Eliminate N+1 DB roundtrip with Postgres CTEs
**Learning:** In Postgres, you can consolidate `UPDATE ... RETURNING` operations with a subsequent bulk `INSERT` into a single database roundtrip using Common Table Expressions (CTEs, e.g., `WITH updated AS (...) INSERT ... SELECT ... FROM updated`). Since a single query is inherently atomic, the explicit `BEGIN` and `COMMIT` statements and extra connection management can be removed.
**Action:** When updating rows and immediately using their returned ids for logging or auditing inserts, always consider a single CTE instead of an N+1 application loop to optimize database roundtrips.
