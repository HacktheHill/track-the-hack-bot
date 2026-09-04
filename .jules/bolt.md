## 2025-02-12 - PostgreSQL Array Column Query Optimization
**Learning:** Using `= ANY(array_column)` when querying PostgreSQL arrays is a common anti-pattern that prevents the query planner from using GIN indices, resulting in a full table scan.
**Action:** When querying array columns like `source_message_ids`, always use the array containment operator `@>` (e.g., `array_column @> ARRAY[]::text[]`) to ensure the GIN index is properly utilized, converting O(n) table scans into O(1) index lookups.
