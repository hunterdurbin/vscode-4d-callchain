// LOCKS: multi-word built-in constants (`On Load`, `Char Quote`, `Is text`)
//        get caller edges via the multi-word ConstantRef tokenizer. Single-
//        word built-ins (`Is text` → no, it's two words; `Is real`, etc.)
//        are covered too — the tokenizer tries 1..5 word matches per start
//        position.

var $quote : Text
var $v : Variant

If (FORM Event code=On Load)
  ALERT("form loaded")
End if

$quote:=Char Quote
If (Type($v)=Is text)
  ALERT($v)
End if
