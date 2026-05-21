// LOCKS: EXECUTE METHOD IN SUBFORM extraction. The first arg is a subform
// object name; the second arg here is the name of a regular project method
// (Subform_Helper_Target) — 4D runs it in the subform's context. The
// resolver must fall back to a ProjectMethod lookup when no
// `<formName>.<methodName>` FormObjectMethod exists.
EXECUTE METHOD IN SUBFORM("MySubform"; "Subform_Helper_Target")
