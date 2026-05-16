// LOCKS: target for OrderForm's `expression: "GetTotal()"` field —
//        proves the form-definition JSON scanner emits a real edge into a
//        project method when the expression is a bare call. The form
//        binds the expression to a displayed value, so this method DOES
//        return — declared via the `#DECLARE(...) -> $result : Type` arrow.
#DECLARE() -> $result : Number
return 0
