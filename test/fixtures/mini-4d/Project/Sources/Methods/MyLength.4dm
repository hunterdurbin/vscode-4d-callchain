// LOCKS: target for Bare_Plus_Builtin_Lookalike.4dm's `MyLength($s)` edge.
//        Declares a return via the `#DECLARE(...) -> $result : Type` arrow
//        form, so the `return` keyword is the correct way to return.
#DECLARE($s : Text) -> $result : Number
return Length($s)+1

