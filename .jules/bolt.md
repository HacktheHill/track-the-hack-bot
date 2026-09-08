
## 2024-05-18 - PostgreSQL GIN Index Array Queries
**Learning:** In PostgreSQL, queries using `= ANY(array_column)` bypass GIN indexes created on `array_column`. To actually utilize the GIN index for arrays, array operators like `@>` (contains) or `&&` (overlap) must be used. Also, when passing a single array argument for these operators in the `pg` driver, it must be double-nested (e.g. `[[value]]`) so it doesn't get flattened into multiple parameters.
**Action:** Always prefer the `@>` operator when querying against indexed array columns instead of `= ANY()`, and ensure parameters are properly nested.
