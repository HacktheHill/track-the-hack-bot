## 2024-05-19 - Postgres GIN Index Pitfall with `= ANY()`
**Learning:** In Postgres, a GIN index on an array column (e.g. `CREATE INDEX ON table USING GIN(array_column)`) is NOT used when querying with `$1 = ANY(array_column)`. The query planner will resort to a sequential scan.
**Action:** Always use the array overlap (`&&`) or contains (`@>`) operators, e.g., `array_column @> ARRAY[$1]::text[]`, to ensure the GIN index is hit when checking for array element membership.
