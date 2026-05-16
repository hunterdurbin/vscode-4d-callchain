// LOCKS: multi-word 4D commands. The multi-word-call pre-pass MUST consume
//        these spans so the bare-name pass does NOT emit phantom `RECORD` /
//        `SET` / `END` Unresolved symbols.
//
// Regression: before the consumedSpans pass, `RECORD LOCK([T])` would emit
// the multi-word BuiltinChain edge AND a stray BareName `RECORD` Unresolved.

RECORD LOCK([Customers])
QUERY BY EXAMPLE([Customers])
SET TIMER(60)
SAVE RECORD([Customers])
