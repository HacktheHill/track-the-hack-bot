## 2024-05-15 - PostgreSQL Array Query Optimization
**Learning:** PostgreSQL's query planner cannot use GIN indexes for `= ANY()` operators on array columns, causing sequential scans on large tables (like `task_proposals`).
**Action:** Always use array containment operators like `@>` (e.g., `source_message_ids @> ARRAY[$1]`) instead of `= ANY()` when filtering by elements in indexed array columns to ensure efficient index lookups.
