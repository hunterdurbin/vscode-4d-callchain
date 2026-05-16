// LOCKS: user-defined constants from Resources/Constants_Project.xlf each
//        get a caller edge when referenced as a bare value. Covers:
//          * `_Rules` (Text)
//          * `Worker_Backend` (Longint)
//          * `MODULE_INVOICES` (Text, ALL_CAPS_UNDERSCORE)
//          * `4Q_TYPE_AuditCreditCards` (Text, starts with digit)

$worker:=Worker_Backend
$module:=MODULE_INVOICES
$ruleTable:=_Rules
$auditKind:=4Q_TYPE_AuditCreditCards
$x:=Worker_Backend+1
