## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.

## 2026-10-14 - CTE Batch Database Consolidation
**Learning:** Performing loops of consecutive SQL queries (`UPDATE` then `INSERT`s) within an application significantly degrades performance due to repeated database roundtrips (the N+1 problem).
**Action:** Use PostgreSQL Common Table Expressions (CTEs) with `RETURNING` clauses to combine an initial data modification (like `UPDATE ... RETURNING`) and subsequent dependent row modifications (like `INSERT ... SELECT FROM updated`) into a single query block, removing explicit `BEGIN`/`COMMIT` transactions and N+1 roundtrips.
