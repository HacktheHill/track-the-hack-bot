## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2024-05-18 - Avoid N+1 DB Queries in transaction with RETURNING
**Learning:** Updating multiple rows using `UPDATE ... RETURNING` and then iterating over the results to `INSERT` corresponding rows in a loop can lead to N+1 query performance bottlenecks.
**Action:** Use a PostgreSQL Common Table Expression (CTE) to combine the `UPDATE` and `INSERT` logic into a single database roundtrip query.
