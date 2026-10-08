## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.

## 2024-10-08 - Consolidate UPDATE and INSERT into CTE
**Learning:** In PostgreSQL, Common Table Expressions (CTEs) can be used to combine `UPDATE ... RETURNING` operations and subsequent `INSERT`s into a single query, preventing N+1 queries during batched database operations. Since a single statement is inherently atomic, explicit `BEGIN` and `COMMIT` transactions can be safely removed.
**Action:** Always look for opportunities to combine sequential dependent statements (especially in loops like `for (const row of result.rows) await insert(...)`) into a single CTE to save database roundtrips and avoid N+1 transaction overhead.
