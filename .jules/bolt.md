## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.

## 2024-05-24 - Batch task_audit_log inserts via CTE
**Learning:** In PostgreSQL, transaction loops performing `UPDATE` followed by a loop of `INSERT`s (like inserting an audit log for each updated row) can cause an N+1 query bottleneck.
**Action:** Use a Common Table Expression (CTE) to perform the `UPDATE ... RETURNING` in one step, and an `INSERT ... SELECT` in the next step, combining everything into a single database roundtrip without breaking the application logic.
