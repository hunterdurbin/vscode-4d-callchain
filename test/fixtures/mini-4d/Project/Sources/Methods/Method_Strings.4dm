// LOCKS:
//   * `New process("Name"; ...)` — NewProcess hint, edge to DispatchedMethod
//   * `EXECUTE METHOD("Name"; ...)` — ExecuteMethodLiteral, edge to EmGetTransaction
//   * `EXECUTE METHOD($var)` — ExecuteMethodDynamic, drops silently when $var
//     hasn't been pinned to a literal (no edge expected, but no crash)
//   * `Formula from string("body")` — Formula hint, body extracted

var $methodName : Text
$methodName:="EmGetTransaction"

New process("DispatchedMethod"; 1024; "dispatched"; $methodName)
EXECUTE METHOD("EmGetTransaction"; *; "arg1"; "arg2")
EXECUTE METHOD($methodName; *; "arg1")
$formula:=Formula from string("$1+1")
