// LOCKS: target of ConfigRepo's `This.cache.get(...)` / `.set(...)` chain.
//        Provides `get` + `set` as ClassFunctions (NOT getters/setters,
//        despite the names — note the explicit `()`).

Class constructor
  This.entries:=New object

Function get($key : Text) : Variant
  $0:=This.entries[$key]

Function set($key : Text; $value : Variant)
  This.entries[$key]:=$value
  $0:=This
