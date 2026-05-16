// LOCKS: `_Test` suffix → ClassFlavor.Test classification.
//        `cs.OrderHydrator.new(...)` is a CsNew edge; the assignment is
//        chained into `.getNormalizedInvoiceFromDatastore(...)` so the
//        local-type tracker is NOT supposed to type `$hydrator` (it's
//        chained — fileParser.isAssignmentChained guards against this).
//        Instead the chain extractor emits a VarChainCall on the same
//        line — locking in that resolution path.

Function test_getNormalizedInvoiceFromDatastore()
  // Test-flavor class function — procedure-style, no return value.
  var $hydrator : cs.OrderHydrator
  $hydrator:=cs.OrderHydrator.new()
  var $result : cs.NormalizedOrder
  $result:=$hydrator.getNormalizedInvoiceFromDatastore(42)
