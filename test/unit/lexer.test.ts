import { describe, expect, it } from "vitest";
import { tokenize, type LexToken, type LexTokenKind } from "../../packages/core/dist";

function findOne(tokens: LexToken[], kind: LexTokenKind, line: number, startChar: number): LexToken {
  const hit = tokens.find(
    (t) => t.kind === kind && t.line === line && t.startChar === startChar
  );
  if (!hit) {
    throw new Error(
      `Expected ${kind} at ${line}:${startChar}. Got:\n${tokens
        .map((t) => `  ${t.kind} ${t.line}:${t.startChar}+${t.length}`)
        .join("\n")}`
    );
  }
  return hit;
}

describe("tokenize", () => {
  it("recognises If/number/$local on a single expression", () => {
    const toks = tokenize("If ($x > 0)");
    findOne(toks, "keyword", 0, 0);    // If
    expect(findOne(toks, "keyword", 0, 0).length).toBe(2);
    const v = findOne(toks, "localVar", 0, 4);
    expect(v.length).toBe(2); // `$x`
    const n = findOne(toks, "number", 0, 9);
    expect(n.length).toBe(1);
  });

  it("treats $exampleVar as a single localVar token covering the $", () => {
    const toks = tokenize("$exampleVar:=42");
    const v = findOne(toks, "localVar", 0, 0);
    expect(v.length).toBe("$exampleVar".length);
    const n = findOne(toks, "number", 0, "$exampleVar:=".length);
    expect(n.length).toBe(2);
  });

  it("treats $0/$1/$12 as parameters but $12abc as localVar", () => {
    const t1 = tokenize("$0:=42");
    findOne(t1, "parameter", 0, 0);

    const t2 = tokenize("$1+$2");
    findOne(t2, "parameter", 0, 0);
    findOne(t2, "parameter", 0, 3);

    const t3 = tokenize("$12abc");
    findOne(t3, "localVar", 0, 0);
    expect(findOne(t3, "localVar", 0, 0).length).toBe("$12abc".length);
  });

  it("comments mask $variables and keywords inside them", () => {
    const t = tokenize("// hello $world If True");
    expect(t.length).toBe(1);
    expect(t[0].kind).toBe("comment");
    expect(t[0].line).toBe(0);
    expect(t[0].startChar).toBe(0);
    expect(t[0].length).toBe("// hello $world If True".length);
  });

  it("multi-line block comment emits one comment per line", () => {
    const src = "/* multi\n  line */ $x";
    const toks = tokenize(src);
    const cmt0 = toks.filter((t) => t.kind === "comment" && t.line === 0);
    const cmt1 = toks.filter((t) => t.kind === "comment" && t.line === 1);
    expect(cmt0).toHaveLength(1);
    expect(cmt1).toHaveLength(1);
    expect(cmt0[0].startChar).toBe(0);
    expect(cmt0[0].length).toBe("/* multi".length);
    expect(cmt1[0].startChar).toBe(0);
    expect(cmt1[0].length).toBe("  line */".length);
    findOne(toks, "localVar", 1, "  line */ ".length);
  });

  it("string literal includes doubled-quote escapes in one span", () => {
    const src = '$msg:="he said ""hi"""';
    const toks = tokenize(src);
    findOne(toks, "localVar", 0, 0);
    const s = findOne(toks, "string", 0, '$msg:='.length);
    expect(s.length).toBe('"he said ""hi"""'.length);
  });

  it("string literal accepts backslash escapes (4D v18+)", () => {
    // MethodMocker("[class]/AffirmAPI/"; ""; "Super(\"\";{}\")")
    // The third argument is one string containing \"\";{}\"
    const src = 'MethodMocker("[class]/AffirmAPI/"; ""; "Super(\\"\\";{}\\")")';
    const toks = tokenize(src);
    // First arg
    findOne(toks, "string", 0, 'MethodMocker('.length);
    // Second arg (empty string)
    findOne(toks, "string", 0, 'MethodMocker("[class]/AffirmAPI/"; '.length);
    // Third arg — full string with backslash escapes treated as one span
    const thirdStart = 'MethodMocker("[class]/AffirmAPI/"; ""; '.length;
    const third = findOne(toks, "string", 0, thirdStart);
    expect(third.length).toBe('"Super(\\"\\";{}\\")"'.length);
  });

  it("string literal handles \\\\ without truncating", () => {
    const src = '$x:="a\\\\b"';
    const toks = tokenize(src);
    const s = findOne(toks, "string", 0, '$x:='.length);
    expect(s.length).toBe('"a\\\\b"'.length);
  });

  it("multi-word keywords match longest first", () => {
    const cases: Array<[string, string]> = [
      ["End for each", "End for each"],
      ["End for", "End for"],
      ["End if", "End if"],
      ["Else if", "Else if"],
      ["Case of", "Case of"],
      ["For each", "For each"],
      ["End SQL", "End SQL"],
      ["Class constructor", "Class constructor"]
    ];
    for (const [src, expected] of cases) {
      const toks = tokenize(src);
      const k = toks.find((t) => t.kind === "keyword" && t.startChar === 0);
      if (!k) throw new Error(`No keyword at start of "${src}"`);
      expect(k.length).toBe(expected.length);
    }
  });

  it("End ifx is NOT End if (boundary check)", () => {
    const toks = tokenize("End ifx");
    const kws = toks.filter((t) => t.kind === "keyword");
    expect(kws).toHaveLength(1);
    expect(kws[0].length).toBe("End".length);
    findOne(toks, "identifier", 0, 4); // `ifx`
  });

  it("interprocess variable <>name covers <> + name", () => {
    const toks = tokenize("<>aALPAlph1:=0");
    const v = findOne(toks, "interprocessVar", 0, 0);
    expect(v.length).toBe("<>aALPAlph1".length);
  });

  it("date and time literals are numbers", () => {
    const t1 = tokenize("!2025-05-16!");
    const d = findOne(t1, "number", 0, 0);
    expect(d.length).toBe("!2025-05-16!".length);

    const t2 = tokenize("?12:34:56?");
    const tm = findOne(t2, "number", 0, 0);
    expect(tm.length).toBe("?12:34:56?".length);
  });

  it("hex literals are numbers", () => {
    const toks = tokenize("0xDEADBEEF");
    const n = findOne(toks, "number", 0, 0);
    expect(n.length).toBe("0xDEADBEEF".length);
  });

  it("#DECLARE at line start is a keyword directive", () => {
    const toks = tokenize("#DECLARE($x : Text)");
    const k = findOne(toks, "keyword", 0, 0);
    expect(k.length).toBe("#DECLARE".length);
    findOne(toks, "localVar", 0, "#DECLARE(".length);
  });

  it("#PROJECT METHOD captures the full multi-word directive", () => {
    const toks = tokenize("#PROJECT METHOD");
    const k = findOne(toks, "keyword", 0, 0);
    expect(k.length).toBe("#PROJECT METHOD".length);
  });

  it("[Table] alone is a tableRef token", () => {
    const toks = tokenize("CREATE RECORD([Payments])");
    const t = findOne(toks, "tableRef", 0, "CREATE RECORD(".length);
    expect(t.length).toBe("[Payments]".length);
    // No fieldRef
    expect(toks.find((x) => x.kind === "fieldRef")).toBeUndefined();
  });

  it("[Table]Field emits ONE fieldRef token covering the whole span", () => {
    const src = "[Payments]TokenType:=42";
    const toks = tokenize(src);
    expect(toks.find((x) => x.kind === "tableRef")).toBeUndefined();
    const f = findOne(toks, "fieldRef", 0, 0);
    expect(f.length).toBe("[Payments]TokenType".length);
    findOne(toks, "number", 0, "[Payments]TokenType:=".length);
  });

  it("[Goals]April is one fieldRef spanning brackets + field", () => {
    const toks = tokenize("If ([Goals]April>0)");
    findOne(toks, "keyword", 0, 0); // If
    const f = findOne(toks, "fieldRef", 0, "If (".length);
    expect(f.length).toBe("[Goals]April".length);
    expect(toks.find((x) => x.kind === "tableRef")).toBeUndefined();
  });

  it("ds[_TableName] is NOT a tableRef (bracket follows an identifier)", () => {
    const toks = tokenize("ds[_TableName].new()");
    expect(toks.find((x) => x.kind === "tableRef")).toBeUndefined();
    // `ds` stays a builtinGlobal (method.defaultLibrary)
    findOne(toks, "builtinGlobal", 0, 0);
  });

  it("underscore-prefixed table names work", () => {
    const toks = tokenize("[_Internal]Field:=1");
    const f = findOne(toks, "fieldRef", 0, 0);
    expect(f.length).toBe("[_Internal]Field".length);
  });

  it("emits identifier tokens for non-keyword words", () => {
    const toks = tokenize("MyMethod($x)");
    findOne(toks, "identifier", 0, 0);
    findOne(toks, "localVar", 0, "MyMethod(".length);
  });

  it("This is a keyword; the suffix after `.` is a property", () => {
    const toks = tokenize("This.foo");
    findOne(toks, "keyword", 0, 0);
    findOne(toks, "operator", 0, "This".length);     // .
    findOne(toks, "property", 0, "This.".length);    // foo
  });

  it("C_LONGINT(<>name) is identifier + interprocessVar", () => {
    const toks = tokenize("C_LONGINT(<>aFoo)");
    findOne(toks, "identifier", 0, 0);
    const v = findOne(toks, "interprocessVar", 0, "C_LONGINT(".length);
    expect(v.length).toBe("<>aFoo".length);
  });

  it("known process variable names tokenize as processVar (case-insensitive)", () => {
    const src = "mockerStats:=MethodMocker_SetupMockerStats()\nMOCKERSTATS:=0";
    const toks = tokenize(src, { processVariables: new Set(["mockerstats"]) });
    const v0 = findOne(toks, "processVar", 0, 0);
    expect(v0.length).toBe("mockerStats".length);
    const v1 = findOne(toks, "processVar", 1, 0);
    expect(v1.length).toBe("MOCKERSTATS".length);
    // The function call after `:=` stays an identifier (symbol pass colors it).
    findOne(toks, "identifier", 0, "mockerStats:=".length);
  });

  it("processVar set has no effect when omitted", () => {
    const toks = tokenize("mockerStats:=0");
    expect(toks.find((x) => x.kind === "processVar")).toBeUndefined();
    findOne(toks, "identifier", 0, 0);
  });

  it("keywords beat the processVar set (you can't shadow `If`)", () => {
    const toks = tokenize("If True", { processVariables: new Set(["if"]) });
    findOne(toks, "keyword", 0, 0);
    expect(toks.find((x) => x.kind === "processVar")).toBeUndefined();
  });

  it("identifier after `:` is a type", () => {
    const toks = tokenize("var $result : Object");
    findOne(toks, "keyword", 0, 0);          // var
    findOne(toks, "localVar", 0, 4);         // $result
    const t = findOne(toks, "type", 0, "var $result : ".length);
    expect(t.length).toBe("Object".length);
  });

  it("type tag survives no-space case `$x:Object`", () => {
    const toks = tokenize("var $x:Object");
    findOne(toks, "type", 0, "var $x:".length);
  });

  it("`:=` is assignment, not a type annotation", () => {
    const toks = tokenize("$x:=Object");
    expect(toks.find((x) => x.kind === "type")).toBeUndefined();
    findOne(toks, "identifier", 0, "$x:=".length);
  });

  it("`var $x : cs.Foo` => builtinGlobal + operator + property", () => {
    const toks = tokenize("var $x : cs.Foo");
    findOne(toks, "builtinGlobal", 0, "var $x : ".length);     // cs
    findOne(toks, "operator",      0, "var $x : cs".length);   // .
    findOne(toks, "property",      0, "var $x : cs.".length);  // Foo
    expect(toks.find((t) => t.kind === "type")).toBeUndefined();
  });

  it("`var $x : cs.NS.Bar` chains: builtinGlobal + property + property", () => {
    const toks = tokenize("var $x : cs.NS.Bar");
    findOne(toks, "builtinGlobal", 0, "var $x : ".length);        // cs
    findOne(toks, "property",      0, "var $x : cs.".length);      // NS
    findOne(toks, "property",      0, "var $x : cs.NS.".length);   // Bar
  });

  it("type chain stops at non-dot punctuation", () => {
    const toks = tokenize("var $x : Text; $y:=Foo");
    findOne(toks, "type", 0, "var $x : ".length); // Text
    // `Foo` after `:=` is identifier (assignment), not type.
    findOne(toks, "identifier", 0, "var $x : Text; $y:=".length);
  });

  it("`#DECLARE($p : Text) -> $r : Object` types tagged", () => {
    const src = "#DECLARE($p : Text) -> $r : Object";
    const toks = tokenize(src);
    findOne(toks, "type", 0, "#DECLARE($p : ".length); // Text
    findOne(toks, "type", 0, "#DECLARE($p : Text) -> $r : ".length); // Object
  });

  it("Case-of pattern doesn't tag later identifiers as type", () => {
    // `: ($var = MyConst)` — the `MyConst` must NOT become a type just because
    // a stray `:` opened a case-of branch earlier on the line.
    const toks = tokenize("  : ($var = MyConst)");
    expect(toks.find((x) => x.kind === "type")).toBeUndefined();
    findOne(toks, "identifier", 0, "  : ($var = ".length);
  });

  it("type-flag does not leak across newlines", () => {
    const toks = tokenize("var $x : Object\nvar $y\nFoo");
    findOne(toks, "type", 0, "var $x : ".length);
    // Line 2: `$y` localVar; nothing tagged type
    expect(toks.find((t) => t.line === 2 && t.kind === "type")).toBeUndefined();
    findOne(toks, "identifier", 2, 0); // `Foo`
  });

  it("`cs` standalone is builtinGlobal (method.defaultLibrary)", () => {
    const toks = tokenize("$x:=cs.Foo");
    findOne(toks, "localVar",      0, 0);
    findOne(toks, "operator",      0, 2); // :=
    findOne(toks, "builtinGlobal", 0, 4); // cs
    findOne(toks, "operator",      0, 6); // .
    findOne(toks, "property",      0, 7); // Foo
  });

  it("`ds`, `Storage`, `Form` also tokenize as builtinGlobal", () => {
    for (const name of ["ds", "Storage", "Form"]) {
      const toks = tokenize(`${name}.X`);
      const g = findOne(toks, "builtinGlobal", 0, 0);
      expect(g.length).toBe(name.length);
    }
  });

  it("`$obj.member.sub` chains: localVar, property, property", () => {
    const toks = tokenize("$obj.member.sub");
    findOne(toks, "localVar", 0, 0);
    findOne(toks, "property", 0, "$obj.".length);
    findOne(toks, "property", 0, "$obj.member.".length);
  });

  it("after `:=`, identifier is not a type", () => {
    const toks = tokenize("$x:=cs");
    expect(toks.find((t) => t.kind === "type")).toBeUndefined();
    findOne(toks, "builtinGlobal", 0, "$x:=".length);
  });

  it("`{bCheckPaid: True}` — key is property, value is keyword", () => {
    const toks = tokenize("{bCheckPaid: True}");
    findOne(toks, "operator", 0, 0);                        // {
    findOne(toks, "property", 0, 1);                        // bCheckPaid
    findOne(toks, "operator", 0, "{bCheckPaid".length);     // :
    findOne(toks, "keyword",  0, "{bCheckPaid: ".length);   // True
    findOne(toks, "operator", 0, "{bCheckPaid: True".length); // }
    expect(toks.find((t) => t.kind === "type")).toBeUndefined();
  });

  it("`{myProperty: \"value\"; myProperty2: 200.20}` — multiple keys", () => {
    const src = '{myProperty: "value"; myProperty2: 200.20}';
    const toks = tokenize(src);
    findOne(toks, "property", 0, 1);                                 // myProperty
    findOne(toks, "string",   0, "{myProperty: ".length);            // "value"
    findOne(toks, "operator", 0, '{myProperty: "value"'.length);     // ;
    findOne(toks, "property", 0, '{myProperty: "value"; '.length);   // myProperty2
    findOne(toks, "number",   0, '{myProperty: "value"; myProperty2: '.length); // 200.20
  });

  it("property keys don't fire on type annotations (`var $x : Object`)", () => {
    const toks = tokenize("var $x : Object");
    // $x is localVar, NOT property
    findOne(toks, "localVar", 0, 4);
    expect(toks.find((t) => t.kind === "property")).toBeUndefined();
    // Object stays as type
    findOne(toks, "type", 0, "var $x : ".length);
  });

  it("property-key separator doesn't open a type slot", () => {
    const toks = tokenize("{key: cs.Foo}");
    findOne(toks, "property",      0, 1);
    findOne(toks, "builtinGlobal", 0, "{key: ".length);
    findOne(toks, "property",      0, "{key: cs.".length);
    expect(toks.find((t) => t.kind === "type")).toBeUndefined();
  });

  it("parens and braces emit operator tokens", () => {
    const toks = tokenize("foo({1; 2})");
    findOne(toks, "operator", 0, 3);  // (
    findOne(toks, "operator", 0, 4);  // {
    findOne(toks, "number",   0, 5);  // 1
    findOne(toks, "operator", 0, 6);  // ;
    findOne(toks, "number",   0, 8);  // 2
    findOne(toks, "operator", 0, 9);  // }
    findOne(toks, "operator", 0, 10); // )
  });

  it("`:=` emits one operator token, not `:` + `=`", () => {
    const toks = tokenize("$x:=1");
    const op = findOne(toks, "operator", 0, 2);
    expect(op.length).toBe(2);
    findOne(toks, "number", 0, 4);
    // Make sure there isn't a stray 1-char `:` operator at position 2.
    const colons = toks.filter((t) => t.kind === "operator" && t.line === 0 && t.startChar === 2);
    expect(colons.length).toBe(1);
  });

  it("comparison operators >= <= are single 2-char operator tokens", () => {
    const t1 = tokenize("If ($x>=10)");
    const op1 = findOne(t1, "operator", 0, "If ($x".length);
    expect(op1.length).toBe(2);

    const t2 = tokenize("If ($x<=10)");
    const op2 = findOne(t2, "operator", 0, "If ($x".length);
    expect(op2.length).toBe(2);
  });

  it("arrow `->` is a single 2-char operator", () => {
    const toks = tokenize("#DECLARE() -> $r : Object");
    const op = findOne(toks, "operator", 0, "#DECLARE() ".length);
    expect(op.length).toBe(2);
  });

  it("member access `.` emits operator tokens", () => {
    const toks = tokenize("$x.foo.bar");
    findOne(toks, "operator", 0, 2);  // first .
    findOne(toks, "operator", 0, 6);  // second .
  });

  it("`#` standalone is an operator (not-equal), `#DECLARE` is still a keyword directive", () => {
    const t1 = tokenize("$x#42");
    findOne(t1, "operator", 0, 2);
    findOne(t1, "number",   0, 3);

    const t2 = tokenize("#DECLARE($p : Text)");
    findOne(t2, "keyword", 0, 0);
    // First operator is the `(` after `#DECLARE`.
    findOne(t2, "operator", 0, "#DECLARE".length);
  });

  it("string keeps subsequent identifiers tokenized correctly", () => {
    const toks = tokenize('ALERT("hi") $x:=1');
    findOne(toks, "identifier", 0, 0);     // ALERT
    findOne(toks, "string", 0, 6);         // "hi"
    findOne(toks, "localVar", 0, 12);      // $x
    findOne(toks, "number", 0, 16);        // 1
  });
});
