// LOCKS: Compiler_*.4dm canonical variable declarations.
//   * `C_LONGINT(<>aALPAlph1)` declares an interprocess variable.
//   * `C_TEXT(aLineItems_Description)` declares a process variable.
// The variable scanner runs a "Compiler-files first" pass so these win as
// the canonical declaration site over any inline use elsewhere.

C_LONGINT(<>aALPAlph1)
C_LONGINT(<>aBraintreeReady)
C_TEXT(aLineItems_Description)
C_TEXT(aSelectedOrderId)
ARRAY TEXT(aLineItems_Codes;0)
