## 2024-10-25 - GIN Index Utilization for Array Columns
**Learning:** Using `= ANY(array_column)` in PostgreSQL queries prevents the query planner from using GIN indexes, resulting in full sequential scans which severely impact performance on large tables.
**Action:** Always use the array containment operator (`@> ARRAY[value]`) or intersection operator (`&&`) when querying array columns (e.g., `source_message_ids`) to ensure GIN indexes are utilized.
