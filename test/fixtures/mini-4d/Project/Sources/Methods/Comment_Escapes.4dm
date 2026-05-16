// LOCKS: comments and string-escape handling — cleanLine() must strip
//        everything below before pattern extraction runs:
//          * single-line `//` comments
//          * `/* block */` comments
//          * doubled-quote `""` inside string literals
//        None of the identifiers in the masked content should appear as
//        edges in the index — only the live call below.

// CallInComment_ShouldBeSkipped
/* CallInBlockComment_AlsoSkipped */
$msg:="she said ""hi"" — also: FakeMethod() in a string"
$msg2:=/* inline block */ "yo"

// One real call so the file contributes at least one resolved edge.
DispatchedMethod
