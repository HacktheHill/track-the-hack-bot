## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.

## 2023-10-23 - Optimizing multi-step database transactions with CTEs
**Learning:** Using `pg` manual transaction boilerplates (`pool.connect()`, `BEGIN`, `COMMIT`, `RELEASE`) for multi-step statements (like an `UPDATE` followed by an `INSERT` into an audit log) creates N+1 database roundtrips and connection management overhead. By leveraging PostgreSQL Common Table Expressions (CTEs), multiple operations can be unified into a single atomic query string executed directly with `pool.query()`.
**Action:** Avoid manual `client.connect()` and transaction blocks when executing related `UPDATE` and `INSERT` steps; combine them with `WITH updated AS (UPDATE ... RETURNING) INSERT ... SELECT ... FROM updated` for better performance.
