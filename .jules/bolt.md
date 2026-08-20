## 2024-05-18 - Promise coalescing for cache stampedes
**Learning:** Returning a cached pending promise instead of awaiting it and storing the value prevents duplicate API calls when concurrent requests ask for the same key.
**Action:** Identify potential cache stampedes in APIs and use promise caching (request coalescing) to prevent redundant external requests.
