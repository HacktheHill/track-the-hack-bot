## 2026-09-10 - GIN Index Utilization on PostgreSQL Array Columns
**Learning:** PostgreSQL's GIN indexes on array columns are not utilized when querying using the `= ANY()` operator. This causes sequential scans on queries targeting array columns (like `source_message_ids`).
**Action:** Always use the array operators like `@>` (contains) or `&&` (overlap) when querying array columns in PostgreSQL to ensure that GIN indexes are utilized effectively.
