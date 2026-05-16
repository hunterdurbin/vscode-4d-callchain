// LOCKS: ds.X.query() → EntitySelection<X> + chain into .orderBy().
//        Exercises ASSIGN_DS_QUERY (line 71 of fileParser) and chain
//        resolution for entity-selection types.

Function findActive()
  var $es : cs.RulesSelection
  $es:=ds.Rules.query("active=:1"; True)
  $es.orderBy("name asc")
