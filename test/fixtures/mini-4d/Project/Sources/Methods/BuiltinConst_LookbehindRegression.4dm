// LOCKS: `[Goals]April` classic-record field access must NOT count toward the
//        BuiltinConstant `April`. The constant-ref word scanner has a negative
//        lookbehind that excludes `]` immediately before a word, so the
//        `April` constant should have zero callers from this file.
//
// Background: before the lookbehind landed, `[Goals]April` falsely incremented
// the April BuiltinConstant's caller count (it lit up in caller-count filters).

If ([Goals]April>0)
  ALERT(String([Goals]April))
End if
