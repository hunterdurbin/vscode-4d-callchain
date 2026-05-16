// LOCKS: inheritance via `Class extends X` and explicit `Super()` /
//        `Super.method()` calls.
//          * `Class extends OrderHydrator` → SymbolRecord.extendsClass
//          * `Super(...)` → SuperCall (no method) — resolved to parent's
//            constructor
//          * `Super.getNormalizedInvoiceFromDatastore(...)` → SuperCall
//            with method — resolved to parent class function

Class extends OrderHydrator

Class constructor
  Super()
  This.bonus:=1

Function overrideHydrate($id : Number) : cs.NormalizedOrder
  var $base : cs.NormalizedOrder
  $base:=Super.getNormalizedInvoiceFromDatastore($id)
  $0:=$base
