// LOCKS: target for Bare_Plus_Builtin_Lookalike.4dm's `MyLength($s)` edge.
//        Uses `return` instead of `$0:=` to exercise the modern return form.
#DECLARE($s : Text)
return Length($s)+1

