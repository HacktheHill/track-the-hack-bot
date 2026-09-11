## 2024-12-08 - PostgreSQL GIN Index Operator for Arrays
**Learning:** Checking array membership with `= ANY(array)` does not leverage GIN indexes effectively, resulting in sequential scans.
**Action:** Use the array containment operator `@> ARRAY[...]` which fully utilizes GIN indexing for array columns.
