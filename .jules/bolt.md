
## 2024-08-22 - Set intersection performance pattern
**Learning:** Calculating Set intersections via `[...setA].filter(x => setB.has(x)).length` is surprisingly slow in hot loops (like duplicate detection or token matching) due to the array allocation and garbage collection overhead.
**Action:** Always compute Set intersections manually using a `for..of` loop and a counter in performance-critical code.
