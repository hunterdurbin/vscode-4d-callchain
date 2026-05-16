// Project method file. LSP call-hierarchy test probes line 1, char 5 —
// CreditCard_ExpDateFromMMandYY      ← line 1; char 5 lands inside "Credit*"
#DECLARE($month : Number; $year : Number) -> $date : Date

$date:=Add to date(!00-00-00!; $year; $month; 1)-1

