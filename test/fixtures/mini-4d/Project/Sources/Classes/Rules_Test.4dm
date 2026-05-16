// LOCKS: ds[_Table] bracket access + chained $var.method() resolution.
//   * `ds[_Rules].new()` → DsBracketNew hint. The resolver strips the
//     leading `_`, validates `Rules` against the catalog, and emits an
//     edge to the builtin `ds.Rules.new` symbol.
//   * `$eRule:=ds[_Rules].new()` types `$eRule` as `dsTable:Rules` (in
//     localTypes). When `$eRule.save()` is then called, the chain
//     resolver sees the type and emits an edge to the user-defined
//     Rules.save ClassFunction.

Function _createActiveRule()
  var $eRule : cs.Rules
  $eRule:=ds[_Rules].new()
  $eRule.save()
  $0:=$eRule
