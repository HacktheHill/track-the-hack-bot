## 2024-05-15 - Optimizing PostgreSQL array queries for GIN indices
**Learning:** In PostgreSQL, queries against array columns that use GIN indexes will perform a sequential scan if the query is formulated as `$1 = ANY(array_column)`. The GIN index is only utilized when array operators such as `@>` (contains) or `&&` (overlap) are used.
**Action:** When querying array columns in PostgreSQL, use `array_column @> ARRAY[$1]` instead of `$1 = ANY(array_column)` to ensure optimal query performance with GIN indexes.
