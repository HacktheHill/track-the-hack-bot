## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2024-05-15 - N+1 Query in PostgreSQL Transactions
**Learning:** The `supersedePendingProposalsForDeletedSource` logic originally utilized an explicit `BEGIN/COMMIT` transaction in JavaScript, within which it ran an `UPDATE` query followed by a `for` loop executing an `INSERT` for every updated row. This causes an N+1 network bottleneck between Node.js and PostgreSQL.
**Action:** Always rewrite batch `UPDATE ... RETURNING` and subsequent `INSERT` patterns as a single PostgreSQL Common Table Expression (CTE). This combines the logic into one atomic database roundtrip, safely removing the need for a manually managed `BEGIN/COMMIT` loop.
