
## 2024-05-18 - Leverage GIN Index for PostgreSQL Array Lookups
**Learning:** In the Node.js Discord bot backend querying PostgreSQL, using the `= ANY()` operator on array columns (like `source_message_ids`) causes a slow O(N) sequential scan, even if a GIN index is defined on that column.
**Action:** When querying PostgreSQL array columns with a parameterized value, always use array operators like `@>` (contains) or `&&` (overlaps) instead of `= ANY()`, and ensure the parameter is passed as an array (e.g. `[[value]]` in `node-postgres`) to correctly utilize GIN indexes.
