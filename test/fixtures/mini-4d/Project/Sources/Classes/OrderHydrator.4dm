// LOCKS: Class file with a regular ClassFunction that calls ≥3 helpers.
//        Covers ClassFunction symbol creation, function-decl param parsing,
//        return-type annotation capture (used for $x.fn().y. chains).

Function getNormalizedInvoiceFromDatastore($id : Number) : cs.NormalizedOrder
  var $entry : Object
  $entry:=New object("id"; $id)
  Bare_ParenLessCalls_Target1
  Bare_ParenLessCalls_Target2
  DispatchedMethod
  $0:=cs.NormalizedOrder.new($entry)

Function helper() : Number
  // Uses `return` rather than `$0:=`. Locks in that the bare `42` after
  // `return` doesn't produce a phantom edge.
  return 42
