## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.

## 2024-05-19 - Use CTEs to Combine PostgreSQL UPDATE and INSERT Operations
**Learning:** In PostgreSQL, iterating over `UPDATE` query results and executing an `INSERT` statement for each row causes an N+1 query problem, leading to unnecessary roundtrips to the database.
**Action:** When combining `UPDATE ... RETURNING` and subsequent `INSERT`s based on those returns, always use Common Table Expressions (CTEs) within a single query. This makes the operation inherently atomic and saves database roundtrips, allowing the explicit `BEGIN`, `COMMIT`, and `ROLLBACK` commands to be removed.
