// LOCKS: provides the inbound edge to CreditCard_ExpDateFromMMandYY so the
//        call-hierarchy test gets a non-empty caller list.

#DECLARE($month : Number; $year : Number)
var $exp : Date
$exp:=CreditCard_ExpDateFromMMandYY($month; $year)
$0:=$exp
