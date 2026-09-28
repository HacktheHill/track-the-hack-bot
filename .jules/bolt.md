## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.
## 2024-09-28 - CTE Batching in PostgreSQL Transactions
**Learning:** Sequential queries in a standard transaction block (BEGIN; UPDATE ... RETURNING; INSERT ...; INSERT ...; COMMIT;) suffer from network roundtrip overhead between Node.js and PostgreSQL for every query, causing an N+1 query bottleneck during batched transactions.
**Action:** When updating rows and logging the audit/revision changes in PostgreSQL, use Common Table Expressions (CTEs) with `WITH updated AS (...) INSERT ... FROM updated` to combine the operations into a single query block. This eliminates the multi-roundtrip transaction overhead.
