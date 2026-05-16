// LOCKS: #DECLARE param signature with multiple typed params + arrow return.
//        The signature-help test asserts that on `4DRequestLog_Parse(` the
//        IDE server hands back the param labels.

#DECLARE($url : Text; $verbose : Boolean) -> $result : Object

var $entry : Object
$entry:=New object("url"; $url; "verbose"; $verbose)
$result:=$entry
