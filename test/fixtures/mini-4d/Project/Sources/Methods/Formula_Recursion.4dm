// LOCKS: `Formula(<body>)` extractor recurses one level into the body so
//        bare-name calls inside the formula are still picked up.

$f:=Formula(SomeNested($1))
$result:=$f.call(Null; "x")
