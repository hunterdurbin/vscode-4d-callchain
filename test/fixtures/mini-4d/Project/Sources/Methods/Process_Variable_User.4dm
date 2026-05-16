// LOCKS: process variables declared in Compiler_Variables.4dm get a caller
//        edge when read in other files. ConstantRef-style word matching is
//        what wires this up: the resolver builds a `process-var name set` and
//        the call extractor emits ConstantRef hints for matching bare names.

aLineItems_Description:="hello"
$x:=aSelectedOrderId
