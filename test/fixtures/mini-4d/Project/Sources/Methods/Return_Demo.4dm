// LOCKS: 4D's `return` keyword (introduced in v18+) as an alternative to
//        `$0:=value`. The parser must:
//          * Treat `Return` as RESERVED — never emit it as a bare-name or
//            ProjectMethodBare edge.
//          * Still extract any call patterns in the expression after
//            `return` (bare-name calls, cs.X.new, multi-word builtins,
//            ds[_X], $var.method, etc.).
//
// Each branch below exercises a different return form.

#DECLARE($mode : Text) -> $result : Variant

If ($mode="empty")
  return
End if

If ($mode="literal")
  return 42
End if

If ($mode="bare-name")
  return MyLength("hello")
End if

If ($mode="cs-new")
  return cs.Result.new("ok")
End if

If ($mode="multi-word")
  return New object("ok"; True)
End if

If ($mode="bare-statement-before-return")
  DispatchedMethod
  return
End if

return Null
