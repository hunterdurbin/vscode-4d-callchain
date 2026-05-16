// LOCKS: paired ClassGetter + ClassSetter on the same property name +
//        a Class constructor. Exercises:
//          * accessor="get" / accessor="set" symbol creation
//          * SymbolKind.ClassConstructor

Class constructor($percentage : Number)
  This.value:=$percentage

Function get splitPercentage() : Number
  $0:=This.value

Function set splitPercentage($v : Number)
  This.value:=$v
