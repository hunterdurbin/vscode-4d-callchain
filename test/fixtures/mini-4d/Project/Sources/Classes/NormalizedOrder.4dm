// LOCKS: ClassGetter symbols (Function get propName).
//        Two getters so we can verify per-class indexing of multiple
//        getters of the same flavor.

property total : Number

Function get shippingCost() : Number
  $0:=10

Function get totalWithTax() : Number
  $0:=This.total*1.07
