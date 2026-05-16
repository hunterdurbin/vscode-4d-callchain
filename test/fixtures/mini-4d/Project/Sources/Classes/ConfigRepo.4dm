// LOCKS: documented class with members spanning multiple kinds. Used by
//        the IDE-feature tests (hover/folding/semanticTokens/completion).
//        Critical contents:
//          * `Function getConfig($key : Text) : cs.Result` — hover probe
//            walks the file for this header
//          * `This.cache := Map.new()` — exercises VarSet + CsNew
//          * a property declaration so This.cache.set/get chain resolves

property cache : cs.Map

Class constructor
  This.cache:=cs.Map.new()

Function getConfig($key : Text) : cs.Result
  var $cached : Variant
  $cached:=This.cache.get($key)
  If ($cached#Null)
    $0:=cs.Result.new($cached)
  Else
    $0:=cs.Result.new(Null)
  End if

Function setConfig($key : Text; $value : Variant)
  // No declared return type → no `$0:=`. Side-effect only.
  This.cache.set($key; $value)
