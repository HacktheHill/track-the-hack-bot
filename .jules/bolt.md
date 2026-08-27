## 2024-05-14 - PostgreSQL GIN Index Bypassed by ANY()
**Learning:** Using `val = ANY(array_column)` in PostgreSQL queries bypasses GIN indexes on the array column, leading to full table scans.
**Action:** When querying array columns that have GIN indexes (like `source_message_ids`), use array overlap operators like `@>` (e.g. `array_column @> ARRAY[val]::text[]`) to ensure the database can efficiently use the index.
