## 2024-05-18 - PostgreSQL GIN Index Scan with Node-PG
**Learning:** When passing array parameters to node-pg to leverage GIN indexes via the `@>` operator, wrap the array in an extra set of brackets (e.g. `[[messageId]]`) to ensure it's evaluated as a PostgreSQL array literal rather than as multiple string arguments. Replacing `$1=ANY(array_column)` with `array_column @> $1::text[]` is a highly effective way to use GIN indexes.
**Action:** When working on DB optimizations querying arrays with GIN index, use `@>` instead of `ANY()` and be mindful of node-pg array wrapping semantics.
