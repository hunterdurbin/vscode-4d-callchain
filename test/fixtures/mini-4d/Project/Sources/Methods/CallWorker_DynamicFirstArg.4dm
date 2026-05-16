// LOCKS: CALL WORKER with a non-string first arg + a string worker name.
//        The CALL WORKER regex matches when the first arg has NO `"` chars
//        after cleanLine. `Choose(...)` over constant identifiers is fine.

#DECLARE($pNum : Number; $params : Object)

CALL WORKER(Choose($pNum; Worker_Backend; Worker_Frontend); "CallWorker_Target"; $params)
