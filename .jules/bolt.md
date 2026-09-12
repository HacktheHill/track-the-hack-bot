## 2024-09-12 - PostgreSQL GIN Index Anti-pattern on Array Columns
**Learning:** Querying an array column (like `source_message_ids`) using `$1 = ANY(array_column)` bypasses GIN indexes, causing full sequential scans.
**Action:** Always use array operators like `@>` (contains) or `&&` (overlap) such as `array_column @> ARRAY[$1]::text[]` when querying array columns to ensure GIN index utilization.
