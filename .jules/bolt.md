## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2024-10-21 - Eliminate N+1 Database Bottlenecks with CTEs
**Learning:** Using explicit `BEGIN`, multiple `INSERT` statements in a loop for each returned row of an `UPDATE`, and `COMMIT` incurs significant connection/transaction overhead and causes an N+1 query issue for bulk database operations.
**Action:** Use PostgreSQL Common Table Expressions (CTEs) combined with `INSERT ... SELECT FROM updated` to reduce complex transactional updates and subsequent batched insertions into a single database roundtrip, safely removing the need for manual connection transaction (`BEGIN`/`COMMIT`) wrappers.
