## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.

## 2024-05-18 - PostgreSQL CTE for Update-then-Insert N+1 Prevention
**Learning:** In PostgreSQL, operations that update rows and then log or insert corresponding records often suffer from N+1 query bottlenecks if implemented via sequential `UPDATE ... RETURNING` and a loop of `INSERT`s in Node.js.
**Action:** Use Common Table Expressions (CTEs) combining `UPDATE ... RETURNING` and a subsequent `INSERT INTO ... SELECT FROM` to execute the operation in a single database roundtrip, significantly reducing application-database overhead and latency.
