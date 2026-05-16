// LOCKS: multi-word built-in constants (`On Load`, `Char Quote`, `Is text`)
//        get caller edges via the multi-word ConstantRef tokenizer. Single-
//        word built-ins (`Is text` → no, it's two words; `Is real`, etc.)
//        are covered too — the tokenizer tries 1..5 word matches per start
//        position.

If (FORM Event code=On Load)
  $0:="form loaded"
End if

$quote:=Char Quote
If (Type($v)=Is text)
  $0:=$v
End if
