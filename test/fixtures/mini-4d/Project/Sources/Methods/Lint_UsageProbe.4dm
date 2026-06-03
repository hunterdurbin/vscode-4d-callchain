// LOCKS: ParsedFile.localReads / localWrites / localDeclMode population
//        + SymbolRecord.bodySpan for file-level project methods. Drives
//        Phase A linter visitor extensions used by unused-local /
//        unused-parameter / decl/implicit-local rules.
//
// Layout:
//   $declaredParam      param, read once       → declared, has read
//   $unusedParam        param, never read      → declared, no read
//   $result             return name, written + read → declared, has read & write
//   $declaredLocal      var-declared, read     → declared, has read & write
//   $declaredButUnread  var-declared, never read → declared, no read but has write
//   $implicitLocal      first-write only       → implicit, has read & write

#DECLARE($declaredParam : Integer; $unusedParam : Text)->$result : Integer

var $declaredLocal : Text
var $declaredButUnread : Boolean

$implicitLocal:=1
$declaredLocal:="hello"
$declaredButUnread:=True

$result:=$declaredParam+$implicitLocal
$result:=$result+Length($declaredLocal)

return $result
