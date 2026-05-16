// LOCKS: ORDA Entity subclass. classForTable("Rules") looks up
//        `RulesEntity` first; when present, chain resolution walks
//        `$eRule.save()` (where $eRule is typed dsTable:Rules) to this
//        class's `save` ClassFunction. This is the "user-defined entity
//        class" path; without RulesEntity, the resolver synthesizes a
//        TableBuiltin instead (also tested separately).

Class extends Entity

Function save()
  // No declared return type → side-effect only. Body intentionally empty.
  This.touched:=True

Function load()
  This.touched:=False
