// LOCKS: 4D v18+ backtick (`) single-line comment recognition. The text
// after the backtick must NOT be extracted as a call site (regression
// guard for "Cannot resolve 'assumes there is a record loaded in classic
// for'" against Symphony's CombineNames_LockedRecord.4dm).
` assumes there is a record loaded in classic for $table

$x:=1
` Backtick_Comment_FakeCall(foo; bar)
EmGetTransaction("save"; "")
