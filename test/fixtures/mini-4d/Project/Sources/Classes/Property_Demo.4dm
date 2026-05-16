// LOCKS: `property name : Type` declarations are captured into
//        classPropertyTypes so the chain resolver can walk
//        `$inst.propName.method()` patterns.

property url : Text
property port : Number
property cache : cs.Map

Class constructor($url : Text)
  This.url:=$url
  This.port:=8080
  This.cache:=cs.Map.new()
