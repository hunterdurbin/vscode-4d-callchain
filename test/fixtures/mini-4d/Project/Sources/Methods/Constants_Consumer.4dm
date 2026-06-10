// LOCKS: user-defined constants from Resources/Constants_Project.xlf each
//        get a caller edge when referenced as a bare value. Covers:
//          * `_Rules` (Text)
//          * `Worker_Backend` (Longint)
//          * `MODULE_INVOICES` (Text, ALL_CAPS_UNDERSCORE)
//          * `4X_TYPE_SAMPLE` (Text, starts with digit)

$worker:=Worker_Backend
$module:=MODULE_INVOICES
$ruleTable:=_Rules
$sampleKind:=4X_TYPE_SAMPLE
$x:=Worker_Backend+1
