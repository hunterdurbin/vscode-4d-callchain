// LOCKS: ORDA Entity subclass. classForTable("Rules") looks up
//        `RulesEntity` first; when present, chain resolution walks
//        `$eRule.save()` (where $eRule is typed dsTable:Rules) to this
//        class's `save` ClassFunction. This is the "user-defined entity
//        class" path; without RulesEntity, the resolver synthesizes a
//        TableBuiltin instead (also tested separately).

Class extends Entity

// LOCKS: Alias attribute — indexed as SymbolKind.Alias with aliasTarget
//        "rule.Name". Exercises the alias_declaration grammar rule.
Alias ruleName rule.Name

Function save()
  // No declared return type → side-effect only. Body intentionally empty.
  This.touched:=True

Function load()
  This.touched:=False
  // Reference the alias attribute so it gets a caller edge (ThisSet → Alias).
  This.ruleName:="default"

// LOCKS: computed-attribute getter + its query backer share the name
//        `isActive`. They surface as distinct ClassGetter vs ClassFunction;
//        the query backer carries accessor "query" + computedFor "isActive".
Function get isActive() : Boolean
  return This.touched

Function query isActive($event : Object) : Object
  return {query: "touched = :1"; parameters: [$event.value]}
