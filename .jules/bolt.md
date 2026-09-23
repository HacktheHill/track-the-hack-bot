## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.

## 2024-10-25 - Prevent N+1 Updates via Postgres Common Table Expressions (CTEs)
**Learning:** Performing multiple independent `INSERT` operations in a `for...of` loop over rows returned by an `UPDATE ... RETURNING` query creates an N+1 query bottleneck. The latency impact multiplies significantly in batched workloads.
**Action:** When updating database rows and subsequently generating correlated audit entries or metadata rows based on the modified data, always use a single `WITH updated AS (...) inserted AS (...)` Common Table Expression to execute the update and correlating inserts in a single database roundtrip.
