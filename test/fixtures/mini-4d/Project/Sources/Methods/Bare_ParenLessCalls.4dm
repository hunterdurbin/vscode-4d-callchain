// LOCKS: parenthesis-less bare-name project method calls
//        `Bare_ParenLessCalls_Target1` and `_Target2` are called WITHOUT
//        parens. The parser's `bareStatement` heuristic must lift these
//        as ProjectMethodBare hints that the resolver maps to the
//        sibling project methods.
//
//        EXPRESSION-POSITION paren-less call: `Not(Bare_ParenLessCalls_Target1)`
//        invokes the method from inside an argument list. The tree-sitter
//        parser must emit a ProjectMethodBare for the inner identifier so the
//        edge resolves. A bare process-variable read in the same position
//        (`vBareExprProbeVar`) must NOT leak as an Unresolved edge — the
//        resolver drops ProjectMethodBare hints with no matching method.

Bare_ParenLessCalls_Target1
Bare_ParenLessCalls_Target2

If (Not(Bare_ParenLessCalls_Target1))
	$x:=vBareExprProbeVar
End if
