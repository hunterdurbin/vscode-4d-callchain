# TODO

## Bugs

### Project methods called without parentheses aren't detected as callees

**Symptom:** In `WebOrder_Assign.4dm` (Symphony), lines 16 and 18 call
`WebOrder_Assign3` and `WebOrder_Assign2` with no `()`. The Callees tree
only shows `WebOrder_Assign`, `Bool`, and `constructor ConfigManager` —
the two bare-name method invocations are invisible.

**Root cause:** `src/indexer/callExtractor.ts` `RE_BARE_CALL` requires
`\s*\(` after the captured identifier. 4D allows calling parameterless
methods by name alone.

**Approach options:**
1. Add a second pattern matching a bare identifier on its own line (or
   followed only by `//` comment / EOL) and filter via the project-method
   existence set so locals/keywords don't false-match.
2. Generalize: match every bare PascalCase/camelCase identifier and filter
   against project-method set (mirrors the constant-ref approach). Higher
   cost but simpler.

**Fixture:** `Project/Sources/Methods/WebOrder_Assign.4dm` lines 16, 18.
After the fix, `WebOrder_Assign` should show ≥4 callees:
`WebOrder_Assign2`, `WebOrder_Assign3`, `Bool`, `cs.ConfigManager.new`.

**Add to smoke-test:** assert `WebOrder_Assign` has edges to both
`WebOrder_Assign2` and `WebOrder_Assign3`.
