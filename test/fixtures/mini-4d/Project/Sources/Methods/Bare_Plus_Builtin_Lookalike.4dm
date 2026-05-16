// LOCKS: bare-name calls resolve project methods AND/OR built-ins. `Length`
//        is a real 4D builtin; `MyLength` is a sibling project method. The
//        resolver must route each to the correct target.

#DECLARE($s : Text)

$a:=Length($s)
$b:=MyLength($s)
$0:=$a+$b
