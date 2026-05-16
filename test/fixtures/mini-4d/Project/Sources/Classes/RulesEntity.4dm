// LOCKS: ORDA Entity subclass. classForTable("Rules") looks up
//        `RulesEntity` first; when present, chain resolution walks
//        `$eRule.save()` (where $eRule is typed dsTable:Rules) to this
//        class's `save` ClassFunction. This is the "user-defined entity
//        class" path; without RulesEntity, the resolver synthesizes a
//        TableBuiltin instead (also tested separately).

Class extends Entity

Function save()
  $0:=True

Function load()
  $0:=True
