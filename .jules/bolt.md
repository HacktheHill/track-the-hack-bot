## 2024-05-24 - PostgreSQL Array Query Optimization
**Learning:** PostgreSQL's `= ANY()` operator does not always utilize GIN indexes effectively for array membership checks, which can result in sequential scans and slow queries for large tables.
**Action:** Use array operators like `@>` (contains) or `&&` (overlap) with properly typed arrays (e.g. `source_message_ids @> $1::text[]`) to ensure PostgreSQL leverages the GIN index for performance improvements.
