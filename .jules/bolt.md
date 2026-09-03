## 2026-09-03 - PostgreSQL GIN Index Array Query Performance
**Learning:** When querying a PostgreSQL array column that has a GIN index (like `source_message_ids`), using `= ANY($1)` causes a sequential scan and ignores the index. Using the `@>` array containment operator with `ARRAY[$1]` (or `&&`) correctly uses the GIN index for faster lookups.
**Action:** Always use array operators like `@>` or `&&` instead of `= ANY()` when querying array columns in PostgreSQL to ensure indexes are utilized properly.
