## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2026-10-24 - [Optimize dismissProposal using CTE]
**Learning:** Using CTEs to combine `UPDATE ... RETURNING` operations and subsequent `INSERT`s into a single query eliminates connection management overhead (e.g. `client.connect()`, `client.release()`) and explicit transaction handling (`BEGIN`, `COMMIT`, `ROLLBACK`), reducing database roundtrips and preventing N+1 query bottlenecks in `pg`.
**Action:** When a method simply performs an `UPDATE ... RETURNING` and then uses the results for a subsequent `INSERT` (like an audit log), rewrite it as a single `pool.query` with a CTE instead of manually checking out a client.
