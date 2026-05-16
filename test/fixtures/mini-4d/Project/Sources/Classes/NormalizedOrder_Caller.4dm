// LOCKS: getter / setter call edges.
//   * `$order.shippingCost` is a VarGet — gives NormalizedOrder.shippingCost
//     a caller.
//   * `$item.splitPercentage:=50` is a VarSet — gives the setter a caller.
//   * `$item.splitPercentage+=5` is BOTH a VarGet (read) and a VarSet (write).
//     Verifies the compound-op fan-out in callExtractor (line ~437).

Function attachAdjustment()
  var $order : cs.NormalizedOrder
  $order:=cs.NormalizedOrder.new()
  var $cost : Number
  $cost:=$order.shippingCost

  var $item : cs.NormalizedOrderItem
  $item:=cs.NormalizedOrderItem.new(50)
  $item.splitPercentage:=75
  $item.splitPercentage+=5
