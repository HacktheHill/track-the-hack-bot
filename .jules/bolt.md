## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## $(date +%Y-%m-%d) - Eliminate N+1 Postgres Roundtrips with CTEs
**Learning:** In PostgreSQL, operations that update a record and log history (like `UPDATE` followed by multiple `INSERT` statements) can be combined into a single atomic statement using Common Table Expressions (CTEs) such as `WITH ... AS (...)`.
**Action:** When performing `UPDATE ... RETURNING` operations followed by dependent `INSERT`s, consolidate them into a single CTE database query to eliminate N+1 roundtrips and avoid the overhead of manual connection management (`client.connect()`) and explicit transaction blocks (`BEGIN`/`COMMIT`).
