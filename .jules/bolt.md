## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2024-05-18 - PostgreSQL CTE vs. Transactions
**Learning:** Sequential `UPDATE ... RETURNING` and `INSERT` queries within a database transaction can become an N+1 bottleneck during batched processing.
**Action:** Use PostgreSQL Common Table Expressions (CTEs) (e.g. `WITH updated AS (UPDATE ... RETURNING ...) INSERT INTO ... SELECT ... FROM updated`) to combine these sequential queries into a single atomic database statement, which eliminates the bottleneck and the need for explicit `BEGIN`/`COMMIT` transaction blocks.
