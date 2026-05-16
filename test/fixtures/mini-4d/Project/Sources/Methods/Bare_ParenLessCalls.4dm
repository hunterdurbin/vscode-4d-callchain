// LOCKS: parenthesis-less bare-name project method calls
//        `Bare_ParenLessCalls_Target1` and `_Target2` are called WITHOUT
//        parens. The parser's `bareStatement` heuristic must lift these
//        as ProjectMethodBare hints that the resolver maps to the
//        sibling project methods.

Bare_ParenLessCalls_Target1
Bare_ParenLessCalls_Target2
