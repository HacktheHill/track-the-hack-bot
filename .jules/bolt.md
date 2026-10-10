## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2023-11-20 - Consolidate batched statements using CTEs in PostgreSQL
**Learning:** Performing multiple independent database updates/inserts within an explicit transaction block creates N+1 latency roundtrips and bottlenecks batch operations. PostgreSQL CTEs (Common Table Expressions) permit consolidating `UPDATE ... RETURNING` results as input rows for subsequent `INSERT` or `UPDATE` queries in a single multi-step operation.
**Action:** Replace sequential operations inside loops or explicit transaction blocks with a unified CTE query where applicable to eliminate unnecessary network latency in Postgres environments.
