// LOCKS: `This.prop += val` (compound assignment) fans out to BOTH
//        a ThisGet (read) and a ThisSet (write).
//        `This.prop := val` is set-only.
//        `This.prop` bare read is get-only.

property counter : Number
property log : Collection

Class constructor
  This.counter:=0
  This.log:=[]

Function increment()
  This.counter+=1
  This.log.push("incremented")

Function read() : Number
  $0:=This.counter
