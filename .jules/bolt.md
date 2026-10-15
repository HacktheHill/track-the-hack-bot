## 2024-05-15 - OpenProject Cache Stampede
**Learning:** The `OpenProjectClient`'s naive `cached()` implementation triggers a cache stampede on startup or high concurrency because it didn't coalesce pending promises. Concurrent requests for `projects()`, `users()`, etc. executed identical API calls.
**Action:** When implementing application-level caching, always store the `Promise` of the work in progress rather than just the final result, preventing duplicate work while the first request is still inflight.

## 2025-02-23 - PostgreSQL N+1 Query in `supersedePendingProposalsForDeletedSource`
**Learning:** The method `supersedePendingProposalsForDeletedSource` in `src/database.ts` originally used an `UPDATE ... RETURNING` query followed by a `for (const row of result.rows) { await client.query(...) }` loop to insert audit logs. This created an N+1 query bottleneck within an explicit transaction.
**Action:** When updating rows and subsequently recording those changes in an audit log, use a PostgreSQL Common Table Expression (CTE) to chain the operations. Specifically, use a `WITH` clause to perform the `UPDATE` and `RETURNING`, and then `INSERT INTO ... SELECT ... FROM` the returned set in the same statement. This combines the operations into a single database roundtrip and inherently provides atomicity without needing explicit `BEGIN`/`COMMIT` blocks.
