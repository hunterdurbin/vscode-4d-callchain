// LOCKS: multi-step $var. chains via the token scanner (iterateChains).
//        `$x.getConfig($key).value` is:
//          * VarChainCall: variable=x, path=[getConfig (call)], method=value? — no
//            wait, `.value` is a property read, not a call.
//        Simpler probe: `$x.getConfig("foo").isOk()` — calls
//          1. $x.getConfig("foo")   (VarCall path=[])
//          2. .isOk()                (VarChainCall path=[getConfig])

Function probe()
  var $x : cs.ConfigRepo
  $x:=cs.ConfigRepo.new()
  var $ok : Boolean
  $ok:=$x.getConfig("foo").isOk()
