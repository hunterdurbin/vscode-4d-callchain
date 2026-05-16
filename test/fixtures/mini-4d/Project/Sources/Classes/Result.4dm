// LOCKS: `cs.Result` — completion-test probe at `cs.Result.` expects this
//        class's members to appear. Members are typed (return-type captured
//        in classMethodReturnsByName / classPropertyTypes) so the chain
//        resolver can walk further.

Class constructor($value : Variant)
  This.value:=$value

Function get value() : Variant
  $0:=This.value

Function get error() : Text
  $0:=""

Function isOk() : Boolean
  // Uses `return` form. Also exercises returning an expression that reads
  // a `This.<prop>` — should emit ThisGet(value) without a stray edge.
  return (This.value#Null)
