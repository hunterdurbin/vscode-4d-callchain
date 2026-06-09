/**
 * @file 4D programming language grammar for tree-sitter.
 * @license MIT
 *
 * Built up in phases (see plan at
 * /Users/hunterdurbin/.claude/plans/let-s-do-the-todo-sleepy-boole.md):
 *
 *  - Phase 0: skeleton (done)
 *  - Phase 1: lexical layer (done)
 *  - Phase 2: declarations — Function, Class, #DECLARE, var, legacy C_*, property
 *  - Phase 3: expressions & calls
 *  - Phase 4: control flow
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

/**
 * Build a case-insensitive RegExp for a keyword string.
 *
 *   kw("if")              → /[iI][fF]/
 *   kw("End if")          → /[eE][nN][dD][ \t]+[iI][fF]/
 *
 * Multi-word keywords accept one-or-more spaces/tabs between words to match
 * 4D's tolerance for messy whitespace.
 */
function kw(text) {
  const body = text
    .split("")
    .map((c) => {
      if (/[a-zA-Z]/.test(c)) {
        const lo = c.toLowerCase();
        const up = c.toUpperCase();
        return `[${lo}${up}]`;
      }
      if (c === " ") return "[ \\t]+";
      return c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    })
    .join("");
  return new RegExp(body);
}

// Expression-precedence constants. Higher numbers bind tighter.
// Roughly mirrors 4D operator precedence; not all levels are syntactically
// distinct in 4D (it's mostly left-to-right), but accurate precedence keeps
// the CST shapes sensible.
const PREC = {
  OR: 1,
  AND: 2,
  COMPARE: 3,
  ADD: 4,
  MUL: 5,
  UNARY: 6,
  MEMBER: 7,
  CALL: 8,
  // Multi-word call must outrank single-word call so `CALL WORKER(...)`
  // parses with `CALL WORKER` as the callee, not `CALL` followed by
  // `WORKER(...)`.
  CALL_MULTIWORD: 9,
};

// 4D's `C_<TYPE>` legacy declaration prefix list, matched as a single
// case-insensitive token. The body (`(...)`) is parsed by `legacy_var_declaration`.
const C_TYPE_KEYWORDS = [
  "LONGINT",
  "INTEGER",
  "REAL",
  "NUMERIC",
  "TEXT",
  "STRING",
  "ALPHA",
  "BOOLEAN",
  "DATE",
  "TIME",
  "BLOB",
  "PICTURE",
  "OBJECT",
  "COLLECTION",
  "POINTER",
  "VARIANT",
];

// 4D's `ARRAY <TYPE>` legacy array declaration prefix list. Same family.
const ARRAY_TYPE_KEYWORDS = [
  "TEXT",
  "LONGINT",
  "INTEGER",
  "REAL",
  "BOOLEAN",
  "DATE",
  "TIME",
  "BLOB",
  "PICTURE",
  "OBJECT",
  "POINTER",
];

module.exports = grammar({
  name: "fourd",

  // Whitespace except newline is auto-skipped. Comments too. `\n` is *not* in
  // extras because we use it as a statement separator. A `\` at the end of a
  // line is 4D's explicit line-continuation marker and is also skipped — it
  // lets declarations like `C_BOOLEAN(\` span multiple physical lines.
  extras: ($) => [
    /[ \t\r]+/,
    /\\\r?\n/, // line-continuation: backslash + newline
    $.line_comment,
    $.backtick_comment,
    $.block_comment,
  ],

  // `identifier` is the "word" token. Combined with `prec(1)` on each
  // keyword's regex, this gives us: `If` is `keyword_if`, but `IfFoo` is
  // `identifier`.
  word: ($) => $.identifier,

  conflicts: ($) => [
    // `If foo bar` is ambiguous: `foo` could be a primary expression
    // (condition) followed by something else, OR `foo bar` could be a
    // multi_word_identifier (condition). We let tree-sitter explore both
    // and keep the longest match — multi-word wins when 2+ words follow.
    [$._primary_expression, $._word_or_keyword],
    // `If (expr)` could be parsed via _if_condition's parenthesized branch
    // OR as a parenthesized_expression nested in _if_condition's bare-
    // expression branch. Both produce equivalent trees; defer to the
    // parser's preferred path.
    [$._if_condition, $.parenthesized_expression],
  ],

  rules: {
    // ---- File structure ----

    source_file: ($) => repeat($._top_level_item),

    _top_level_item: ($) =>
      choice(
        $._declaration,
        $.directive_statement,
        $._statement,
        $._newline,
      ),

    // Directives stand on their own at top level: `#PROJECT METHOD`,
    // `#PROPERTIES`. Separate from `_statement` because tree-sitter's LR
    // analysis can't reach `directive` through `_primary_expression` at
    // start-of-line — the `#` token gets snapped up by `binary_expression`
    // before the parser can backtrack into the directive's longer match.
    directive_statement: ($) => seq($.directive, $._newline),

    _newline: ($) => /\n/,

    _declaration: ($) =>
      choice(
        $.class_extends_header,
        $.class_end,
        $.constructor_declaration,
        $.function_declaration,
        $.property_declaration,
        $.alias_declaration,
        $.var_declaration,
        $.legacy_var_declaration,
        $.legacy_array_declaration,
        $.declare_directive,
      ),

    // ---- Declarations ----

    // `Class extends Foo` or `Class extends cs.Bar`.
    class_extends_header: ($) =>
      seq(
        $.keyword_class_extends,
        field("base", $._type_ref),
        $._newline,
      ),

    // Optional file-terminating `End class`. 4D treats class files as
    // implicitly ending at EOF; some legacy files write the explicit form.
    class_end: ($) => seq($.keyword_end_class, $._newline),

    // `Class constructor` optionally followed by a parameter list.
    //   Class constructor
    //   Class constructor($a : Text; $b : Number)
    constructor_declaration: ($) =>
      seq(
        $.keyword_class_constructor,
        optional(field("parameters", $.parameter_list)),
        $._newline,
      ),

    // `Function name(...)` and variants:
    //   Function foo()
    //   Function foo($a : Text) : Number
    //   Function get foo() : cs.Bar
    //   Function set foo($value : Text)
    //   Function get($k : Text)        ← function literally named `get`
    //   Function set($k : Text; $v)     ← function literally named `set`
    //   local Function foo(...)
    //   shared Function foo(...)
    //
    // The `get`/`set` ambiguity: `Function get` followed by an identifier is
    // a property getter; `Function get` followed by `(` is a plain function
    // named `get`. Tree-sitter's LR machinery explores both interpretations
    // because the `name` field accepts aliased keyword tokens.
    function_declaration: ($) =>
      seq(
        field("scope", optional(choice($.keyword_local, $.keyword_shared))),
        $.keyword_function,
        // get/set are keyword tokens; query/orderBy (the ORDA computed-attribute
        // query/sort backers) aren't reserved words, so they arrive as plain
        // identifiers — the visitor recognizes them by text. Using `identifier`
        // here rather than new keyword tokens avoids changing how `query` lexes
        // everywhere else (member access `.query`, object keys `{query: …}`).
        field("accessor", optional(choice($.keyword_get, $.keyword_set, $.identifier))),
        field("name", $._function_name),
        field("parameters", optional($.parameter_list)),
        field("return_type", optional($.return_type_annotation)),
        $._newline,
      ),

    // A function's name is either a plain identifier or one of the
    // contextual keywords that 4D allows as function names (`get`, `set`).
    // Aliasing to `identifier` keeps the CST uniform for the visitor.
    _function_name: ($) =>
      choice(
        $.identifier,
        alias($.keyword_get, $.identifier),
        alias($.keyword_set, $.identifier),
      ),

    // Optional explicit `End function`.
    // (Not currently emitted as a declaration node since most files don't
    //  use it — caught by `_misc_statement` fallback.)

    // `(param; param; ...)`. Empty list `()` is allowed.
    parameter_list: ($) =>
      seq(
        "(",
        optional(seq($.parameter_decl, repeat(seq(";", $.parameter_decl)))),
        ")",
      ),

    // A single parameter declaration: `$name` or `$name : Type`.
    parameter_decl: ($) =>
      seq(
        field("name", choice($.parameter, $.local_var)),
        optional(seq(":", field("type", $._type_ref))),
      ),

    // ` : SomeType` — return type annotation on Function/#DECLARE arrow form.
    return_type_annotation: ($) =>
      seq(":", field("type", $._type_ref)),

    // Type reference. Dotted segments allow `cs.Foo`, `cs.NS.Bar`, plus the
    // simple builtin types (`Text`, `Object`, `Number`, ...). Anything that
    // parses as a dotted identifier chain is accepted; semantic validation is
    // visitor-level.
    _type_ref: ($) => $.type_reference,
    type_reference: ($) =>
      seq($.identifier, repeat(seq(".", $.identifier))),

    // `property name` or `property name : Type`. Class-body only — at the
    // grammar level we accept anywhere; the visitor enforces context.
    property_declaration: ($) =>
      seq(
        $.keyword_property,
        field("name", $.identifier),
        field("type", optional($.return_type_annotation)),
        $._newline,
      ),

    // ORDA computed/alias attribute: `Alias <name> <targetPath>`
    // (e.g. `Alias invoiceId invoice.InvoiceID`). Class-body only; the
    // visitor enforces context. `type_reference` is the dotted target path.
    alias_declaration: ($) =>
      seq(
        $.keyword_alias,
        field("name", $.identifier),
        field("target", $.type_reference),
        $._newline,
      ),

    // Modern `var` declaration:
    //   var $name : Text
    //   var $a; $b : Number    ← multi-var shared type
    //   var <>shared : Boolean
    var_declaration: ($) =>
      seq(
        $.keyword_var,
        $._var_decl_names,
        optional(seq(":", field("type", $._type_ref))),
        $._newline,
      ),

    _var_decl_names: ($) =>
      seq(
        choice($.local_var, $.interprocess_var, $.parameter, $.identifier),
        repeat(
          seq(
            ";",
            choice($.local_var, $.interprocess_var, $.parameter, $.identifier),
          ),
        ),
      ),

    // Legacy single-type declarations: `C_LONGINT($a; $b)`, `C_TEXT(name)`, etc.
    // Multi-line continuation (paren-balanced across lines) is supported by
    // making the body span newlines via repeat — see `_legacy_body` below.
    legacy_var_declaration: ($) =>
      seq(
        $.c_type_keyword,
        "(",
        optional(seq($._legacy_decl_item, repeat(seq(";", $._legacy_decl_item)))),
        ")",
        $._newline,
      ),

    // Legacy array declarations: `ARRAY TEXT(arr; size)`, etc.
    legacy_array_declaration: ($) =>
      seq(
        $.array_type_keyword,
        "(",
        optional(
          seq($._legacy_decl_item, repeat(seq(";", $._legacy_decl_item))),
        ),
        ")",
        $._newline,
      ),

    // An item inside a legacy C_*/ARRAY * body. The first item is usually a
    // variable name; subsequent items may be sizes (numbers) or more vars.
    // Accepts any token shape so we don't choke on real-world variation.
    _legacy_decl_item: ($) =>
      choice(
        $.local_var,
        $.interprocess_var,
        $.parameter,
        $.identifier,
        $.number,
        $.string,
      ),

    // `C_<TYPE>` legacy type prefix as a single token. Case-insensitive.
    // `\b` boundary so `C_LONGINTx` doesn't match.
    c_type_keyword: ($) =>
      token(
        prec(
          1,
          new RegExp(
            "[cC]_(" +
              C_TYPE_KEYWORDS.map(kwordCaseInsensitive).join("|") +
              ")",
          ),
        ),
      ),

    // `ARRAY <TYPE>` legacy array type prefix as a single token. Whitespace
    // between ARRAY and the type is required.
    array_type_keyword: ($) =>
      token(
        prec(
          1,
          new RegExp(
            "[aA][rR][rR][aA][yY][ \\t]+(" +
              ARRAY_TYPE_KEYWORDS.map(kwordCaseInsensitive).join("|") +
              ")",
          ),
        ),
      ),

    // `#DECLARE($a : T; $b)` — with optional return type. Two forms:
    //   * arrow: `-> $result : Type` (4D v18+ canonical)
    //   * colon: `: Type` (shorter form, used in some legacy / Symphony code)
    declare_directive: ($) =>
      seq(
        $.declare_keyword,
        field("parameters", $.parameter_list),
        field("return", optional(choice($.declare_return, $.declare_return_short))),
        $._newline,
      ),

    // ` -> $result : Type` — the arrow return form.
    declare_return: ($) =>
      seq(
        "->",
        field("name", $.local_var),
        optional(seq(":", field("type", $._type_ref))),
      ),

    // ` : Type` — the short colon-only return form (no $name).
    declare_return_short: ($) =>
      seq(":", field("type", $._type_ref)),

    // The `#DECLARE` directive keyword, distinct from the general `directive`
    // token so the parser can take the structured path.
    declare_keyword: ($) => token(prec(2, kw("#DECLARE"))),

    // ---- Statements ----

    _statement: ($) =>
      choice(
        $.return_statement,
        $.break_statement,
        $.continue_statement,
        $.assignment_statement,
        $.expression_statement,
        $.if_statement,
        $.case_of_statement,
        $.for_statement,
        $.for_each_statement,
        $.while_statement,
        $.repeat_statement,
        $.use_statement,
        $.sql_block,
        $.try_statement,
        $.throw_statement,
      ),

    // Block contents: statements + variable declarations + blank lines. 4D
    // allows `var` and legacy `C_*`/`ARRAY *` declarations inside `If` /
    // `For` / `While` / etc. (but NOT `Function` / `Class` declarations —
    // those stay top-level only).
    _block_item: ($) =>
      choice(
        $._statement,
        $.var_declaration,
        $.legacy_var_declaration,
        $.legacy_array_declaration,
        $._newline,
      ),

    // ---- Control flow ----

    // `If <condition> ... End if`. 4D allows both `If (a)` and `If a`
    // forms. When written `If (a) && (b)`, the && and trailing parens land
    // in `_if_tail` so the if_statement boundary stays clean instead of
    // cascade-erroring the whole block.
    if_statement: ($) =>
      seq(
        $.keyword_if,
        field("condition", $._if_condition),
        optional($._if_tail),
        $._newline,
        field("then", repeat($._block_item)),
        repeat(field("else_if", $.else_if_clause)),
        optional(field("else", $.else_clause)),
        $.keyword_end_if,
        $._newline,
      ),

    // Either `(expr)` (syntactic parens, conventional 4D style) or a bare
    // `expr` (`If $x`, `If True`, ...). We prefer the parenthesized form
    // when present because it makes the if's end-of-condition unambiguous
    // (closing `)`).
    _if_condition: ($) =>
      choice(
        seq("(", $._expression, ")"),
        $._expression,
      ),

    // Tail expression after `If (...)` — captures the `&& (b)` part of
    // `If (a) && (b)` so the if_statement doesn't terminate at `)` and
    // try to parse `&& (b)` as a new statement.
    _if_tail: ($) =>
      repeat1(
        choice(
          $.op_other,
          $.op_neq,
          $.parenthesized_expression,
          $.identifier,
          $.local_var,
          $.parameter,
          $.interprocess_var,
          $.field_ref,
          $.table_ref,
          $.number,
          $.string,
          $.keyword_this,
          $.keyword_super,
          $.keyword_new,
          $.keyword_true,
          $.keyword_false,
          $.keyword_null,
          $.op_dot,
        ),
      ),

    else_if_clause: ($) =>
      seq(
        $.keyword_else_if,
        field("condition", $._if_condition),
        optional($._if_tail),
        $._newline,
        repeat($._block_item),
      ),

    else_clause: ($) =>
      seq($.keyword_else, $._newline, repeat($._block_item)),

    case_of_statement: ($) =>
      seq(
        $.keyword_case_of,
        $._newline,
        repeat($._block_item),
        repeat(field("arm", $.case_label_arm)),
        optional(field("else", $.case_else_clause)),
        $.keyword_end_case,
        $._newline,
      ),

    // A Case-of arm: the `:` label line plus the body up to the next arm or
    // Else / End case.
    case_label_arm: ($) =>
      seq(
        ":",
        "(",
        field("condition", $._expression),
        ")",
        optional($._if_tail),
        $._newline,
        repeat($._block_item),
      ),

    case_else_clause: ($) =>
      seq($.keyword_else, $._newline, repeat($._block_item)),

    // Standalone case label outside a Case of (kept as a fallback so loose
    // `:` lines don't error). Not normally produced once `case_of_statement`
    // is active.
    case_label: ($) =>
      seq(
        ":",
        optional(field("condition", $._expression)),
        $._newline,
      ),

    for_statement: ($) =>
      seq(
        $.keyword_for,
        "(",
        field("counter", $._expression),
        ";",
        field("start", $._expression),
        ";",
        field("end", $._expression),
        optional(seq(";", field("step", $._expression))),
        ")",
        $._newline,
        repeat($._block_item),
        $.keyword_end_for,
        $._newline,
      ),

    for_each_statement: ($) =>
      seq(
        $.keyword_for_each,
        "(",
        field("element", $._expression),
        ";",
        field("collection", $._expression),
        repeat(seq(";", $._expression)),
        ")",
        // Optional `Until (expr)` early-exit clause: `For each ($x; $c) Until ($cond)`.
        optional(seq($.keyword_until, $._if_condition)),
        $._newline,
        repeat($._block_item),
        $.keyword_end_for_each,
        $._newline,
      ),

    while_statement: ($) =>
      seq(
        $.keyword_while,
        field("condition", $._if_condition),
        optional($._if_tail),
        $._newline,
        repeat($._block_item),
        $.keyword_end_while,
        $._newline,
      ),

    repeat_statement: ($) =>
      seq(
        $.keyword_repeat,
        $._newline,
        repeat($._block_item),
        $.keyword_until,
        field("condition", $._if_condition),
        optional($._if_tail),
        $._newline,
      ),

    use_statement: ($) =>
      seq(
        $.keyword_use,
        "(",
        field("semaphore", $._expression),
        ")",
        $._newline,
        repeat($._block_item),
        $.keyword_end_use,
        $._newline,
      ),

    // `Begin SQL ... End SQL`. The body is opaque — for now we accept any
    // tokens between the keywords; a future external scanner could capture
    // it as a single raw string. The `End SQL Without` variant is also
    // recognized (4D's "no select" form).
    sql_block: ($) =>
      seq(
        $.keyword_begin_sql,
        $._newline,
        repeat(choice($._sql_body_token, $._newline)),
        choice($.keyword_end_sql, $.keyword_end_sql_without),
        $._newline,
      ),

    keyword_end_sql_without: ($) =>
      token(prec(1, kw("end sql without"))),

    // Token classes we tolerate inside a SQL block. Doesn't aim to parse
    // SQL — just to absorb anything until `End SQL`.
    _sql_body_token: ($) =>
      choice(
        $.identifier,
        $.local_var,
        $.parameter,
        $.interprocess_var,
        $.field_ref,
        $.table_ref,
        $.number,
        $.string,
        $.op_dot,
        $.op_assign,
        $.op_colon,
        $.op_arrow,
        $.op_lparen,
        $.op_rparen,
        $.op_lbrace,
        $.op_rbrace,
        $.op_lbracket,
        $.op_rbracket,
        $.op_semi,
        $.op_comma,
        $.op_other,
        $.op_neq,
        // Most keywords are also valid as SQL identifiers; absorb them.
        $.keyword_if,
        $.keyword_else,
        $.keyword_for,
        $.keyword_while,
        $.keyword_this,
        $.keyword_new,
        $.keyword_true,
        $.keyword_false,
        $.keyword_null,
      ),

    try_statement: ($) =>
      seq(
        $.keyword_try,
        $._newline,
        field("body", repeat($._block_item)),
        optional(field("catch", $.catch_clause)),
        $.keyword_end_try,
        $._newline,
      ),

    keyword_end_try: ($) => token(prec(1, kw("end try"))),

    catch_clause: ($) =>
      seq($.keyword_catch, $._newline, repeat($._block_item)),

    throw_statement: ($) =>
      seq($.keyword_throw, optional($._expression), $._newline),

    // `return` with an optional expression. Used both in Functions (with
    // value) and in #DECLARE methods (without value when followed by `$0:=`).
    return_statement: ($) =>
      seq(
        $.keyword_return,
        optional(field("value", $._expression)),
        $._newline,
      ),

    // `break` exits the enclosing loop (4D v18+).
    break_statement: ($) => seq($.keyword_break, $._newline),

    // `continue` skips to the next iteration of the enclosing loop (4D v18+).
    continue_statement: ($) => seq($.keyword_continue, $._newline),

    // `target := value`, `target += value`, etc. Compound forms are emitted
    // as a distinct `compound_assign_op` so the visitor can synthesize the
    // implicit read.
    assignment_statement: ($) =>
      seq(
        field("target", $._expression),
        field(
          "operator",
          choice($.op_assign, $.compound_assign_op),
        ),
        field("value", $._expression),
        $._newline,
      ),

    // Any expression appearing alone on a line — covers bare-name calls
    // (`DispatchedMethod` with no parens), parenthesized calls, member
    // chains, and special-form invocations like `CALL WORKER(...)`.
    expression_statement: ($) =>
      seq(field("expression", $._expression), $._newline),


    // ---- Expressions ----

    _expression: ($) =>
      choice(
        $._primary_expression,
        $.member_expression,
        $.call_expression,
        $.subscript_expression,
        $.binary_expression,
        $.unary_expression,
        $.ternary_expression,
        $.parenthesized_expression,
        $.object_literal,
        $.collection_literal,
      ),

    // 4D ternary: `cond ? then_value : else_value`. Right-associative.
    ternary_expression: ($) =>
      prec.right(
        PREC.OR - 1,
        seq(
          field("condition", $._expression),
          "?",
          field("then", $._expression),
          ":",
          field("else", $._expression),
        ),
      ),

    _primary_expression: ($) =>
      choice(
        $.identifier,
        $.local_var,
        $.parameter,
        $.interprocess_var,
        $.field_ref,
        $.table_ref,
        $.number,
        $.string,
        $.keyword_this,
        $.keyword_super,
        $.keyword_true,
        $.keyword_false,
        $.keyword_null,
        // Multi-word commands can appear without parens too — e.g.
        // `This.entries:=New object` (where `New object` returns an empty
        // object). Adding here means a bare `New object` is a complete
        // expression; wrapping in `(args)` makes it a call.
        $.multi_word_identifier,
        // `*` as a builtin "wildcard" argument — e.g.
        // `EXECUTE METHOD("name"; *; "arg")` passes `*` to mean
        // "current process." Tree-sitter sees this in argument position.
        $.wildcard,
      ),

    // Wildcard literal `*` used as a 4D builtin argument.
    wildcard: ($) => "*",

    // `expr.name` — member access. `name` can be a regular identifier or a
    // contextual keyword (since 4D allows e.g. `cs.Foo.get(...)` and chains
    // off `This.set`).
    member_expression: ($) =>
      prec.left(
        PREC.MEMBER,
        seq(
          field("object", $._expression),
          ".",
          field("property", $._member_name),
        ),
      ),

    _member_name: ($) =>
      choice(
        $.identifier,
        alias($.keyword_get, $.identifier),
        alias($.keyword_set, $.identifier),
        alias($.keyword_new, $.identifier),
      ),

    // `expr[index]` — bracket subscript. Distinct from `[Table]` and
    // `[Table]Field` tokens because those are lexed atomically. Also
    // accepts `expr{index}` — 4D's legacy-array curly-brace subscript
    // syntax (`aPrices{3}`), kept as the same node type since the
    // semantic effect is the same.
    subscript_expression: ($) =>
      prec.left(
        PREC.MEMBER,
        choice(
          seq(
            field("object", $._expression),
            "[",
            field("index", $._expression),
            "]",
          ),
          seq(
            field("object", $._expression),
            "{",
            field("index", $._expression),
            "}",
          ),
        ),
      ),

    // Function or method call: `expr(args)`. The callee can be any
    // expression (covers `Foo(...)`, `cs.X.method(...)`, `$x.method(...)`,
    // `This.method(...)`, and — via `multi_word_identifier` as a primary
    // expression — `CALL WORKER(...)`, `New process(...)`, etc.).
    call_expression: ($) =>
      prec.left(
        PREC.CALL,
        seq(
          field("function", $._expression),
          field("arguments", $.argument_list),
        ),
      ),

    // Multi-word command callee. Allows certain contextual keywords (`New`,
    // `Get`, `Set`) as either the head or trailing words — necessary for
    // `New object(...)`, `New collection(...)`, `OB Get(...)`, `OB Set(...)`,
    // etc. Pure identifiers still cover the bulk: `CALL WORKER`,
    // `EXECUTE METHOD`, `Open form window`.
    multi_word_identifier: ($) =>
      prec.left(seq($._word_or_keyword, repeat1($._word_or_keyword))),

    _word_or_keyword: ($) =>
      choice(
        $.identifier,
        alias($.keyword_new, $.identifier),
        alias($.keyword_get, $.identifier),
        alias($.keyword_set, $.identifier),
        // `USE` appears in commands like `USE SET(...)` (uppercase, distinct
        // from the `Use (lock)` block keyword) — alias so multi-word call
        // recognizes it.
        alias($.keyword_use, $.identifier),
      ),

    argument_list: ($) =>
      seq(
        "(",
        optional(seq($._expression, repeat(seq(";", $._expression)))),
        ")",
      ),

    parenthesized_expression: ($) => seq("(", $._expression, ")"),

    // `{key: value; key: value; ...}` — 4D object literal. Keys are bare
    // identifiers, separator is `;`.
    object_literal: ($) =>
      seq(
        "{",
        optional(seq($.object_entry, repeat(seq(";", $.object_entry)))),
        "}",
      ),

    object_entry: ($) =>
      seq(
        field("key", choice($.identifier, $.string)),
        ":",
        field("value", $._expression),
      ),

    // `[1; 2; 3]` — Note this conflicts with `[Table]` token. Real 4D
    // collections are usually built via `New collection(...)` rather than
    // bracket literals. Including this rule for completeness; the
    // `[Identifier]` shape wins via the token rule.
    collection_literal: ($) =>
      seq(
        "[",
        optional(seq($._expression, repeat(seq(";", $._expression)))),
        "]",
      ),

    // Binary operators, precedence roughly mirroring 4D. We don't strictly
    // need every level — the visitor walks the tree by node kind, not
    // operator precedence — but accurate precedence keeps the CST shapes
    // sensible.
    binary_expression: ($) =>
      choice(
        // `||` and `&&` are 4D's logical "or" / "and" (same as `|`/`&` but
        // commonly written doubled in v18+). Token() so they don't lex as
        // two separate `|`/`&` chars.
        prec.left(PREC.OR, seq($._expression, token("||"), $._expression)),
        prec.left(PREC.OR, seq($._expression, "|", $._expression)),
        prec.left(PREC.AND, seq($._expression, token("&&"), $._expression)),
        prec.left(PREC.AND, seq($._expression, "&", $._expression)),
        prec.left(
          PREC.COMPARE,
          seq(
            $._expression,
            choice("=", "#", "<", ">", token(">="), token("<=")),
            $._expression,
          ),
        ),
        prec.left(
          PREC.ADD,
          seq($._expression, choice("+", "-"), $._expression),
        ),
        prec.left(
          PREC.MUL,
          seq($._expression, choice("*", "/", "^"), $._expression),
        ),
      ),

    unary_expression: ($) =>
      choice(
        prec.right(
          PREC.UNARY,
          seq(
            // Prefix: `->expr` (pointer-to operator), `-expr` (negate), `+expr`.
            choice("-", "+", token("->")),
            $._expression,
          ),
        ),
        // Postfix: `expr->` (pointer dereference, 4D's "read value pointed
        // to" operator). Higher precedence so it binds tightly to its
        // operand. Same `->` token as prefix; tree-sitter chooses by
        // context.
        prec.left(
          PREC.MEMBER,
          seq($._expression, token.immediate("->")),
        ),
      ),

    // Compound-assignment operator: `+=`, `-=`, `*=`, `/=`. A single token so
    // it doesn't collide with `+` followed by `=`.
    compound_assign_op: ($) => token(/[+\-*/]=/),

    // ---- Operators (named so the catch-all can reference them) ----

    op_dot: ($) => ".",
    op_assign: ($) => ":=",
    op_colon: ($) => ":",
    op_arrow: ($) => "->",
    op_lparen: ($) => "(",
    op_rparen: ($) => ")",
    op_lbrace: ($) => "{",
    op_rbrace: ($) => "}",
    op_lbracket: ($) => "[",
    op_rbracket: ($) => "]",
    op_semi: ($) => ";",
    op_comma: ($) => ",",
    // Single-char operators. `*` is multiplication AND the builtin wildcard
    // (a separate `wildcard` rule); the grammar picks by context.
    op_other: ($) => token(/[+\-*/=<>&|^]|>=|<=/),
    // `#` as a comparison operator ("not equal"). Pulled out so the longer
    // `directive` token at prec(3) wins when the lexer sees `#` at the
    // start of `#PROJECT METHOD` / `#PROPERTIES`.
    op_neq: ($) => "#",

    // ---- Token rules (Phase 1, unchanged) ----

    // Identifier — letters, digits, and underscore. Must contain at least one
    // letter or underscore (otherwise it's a number). 4D allows constants and
    // identifiers to start with a digit (`4Q_TYPE_X`).
    identifier: ($) => /[A-Za-z0-9_]*[A-Za-z_][A-Za-z0-9_]*/,
    local_var: ($) =>
      /\$[A-Za-z_][A-Za-z0-9_]*|\$\d+[A-Za-z_][A-Za-z0-9_]*/,
    parameter: ($) => /\$\d+/,
    interprocess_var: ($) => /<>[A-Za-z_][A-Za-z0-9_]*/,
    field_ref: ($) => /\[[A-Za-z_][A-Za-z0-9_]*\][A-Za-z_][A-Za-z0-9_]*/,
    table_ref: ($) => /\[[A-Za-z_][A-Za-z0-9_]*\]/,

    // Number literals.
    //
    // Hex (`0xCAFE`) and scientific (`5e2`) forms need `prec(2)` to beat an
    // identifier match of the same length (since `identifier` now allows
    // digit-first and letter-middle: `5e2` matches identifier regex too).
    // Plain integers (`42`) don't overlap with identifier (it requires at
    // least one letter or underscore). Decimal (`3.14`), date, and time
    // forms have characters that identifier can't accept.
    number: ($) =>
      choice(
        token(prec(2, /0[xX][0-9a-fA-F]+/)),
        token(/\d+\.\d+([eE][+-]?\d+)?/),
        token(prec(2, /\d+[eE][+-]?\d+/)),
        token(/\d+/),
        token(/![\d\-]{1,12}!/),
        token(/\?[\d:]{1,10}\?/),
      ),

    string: ($) =>
      token(
        seq(
          '"',
          repeat(choice(/[^"\\\n]/, /""/, /\\./)),
          '"',
        ),
      ),

    line_comment: ($) => token(seq("//", /[^\n]*/)),

    // 4D v18+ also accepts a backtick at column-zero (or anywhere a token
    // can start) as a single-line comment marker — Symphony-era code uses
    // it for author/annotation lines like `` `assumes there is a record
    // loaded in classic for $table ``. Treat the rest of the line as
    // comment text, identical to `//`.
    backtick_comment: ($) => token(seq("`", /[^\n]*/)),

    block_comment: ($) =>
      token(seq("/*", /([^*]|\*+[^*/])*/, /\*+\//)),

    // General-purpose directive (anything matching `#KEYWORD ...` at line
    // start that isn't the structured `#DECLARE`). Case-insensitive regex
    // for each keyword. `prec(3)` ensures these win at character zero over
    // the bare `#` token used elsewhere (`binary_expression` choice).
    directive: ($) =>
      token(
        prec(
          3,
          choice(
            /#[pP][rR][oO][jJ][eE][cC][tT][ \t]+[mM][eE][tT][hH][oO][dD]/,
            /#[pP][rR][oO][pP][eE][rR][tT][iI][eE][sS]/,
          ),
        ),
      ),

    // ---- Keywords ----

    keyword_if: ($) => token(prec(1, kw("if"))),
    keyword_else: ($) => token(prec(1, kw("else"))),
    keyword_end_if: ($) => token(prec(1, kw("end if"))),
    keyword_else_if: ($) => token(prec(1, kw("else if"))),

    keyword_case_of: ($) => token(prec(1, kw("case of"))),
    keyword_end_case: ($) => token(prec(1, kw("end case"))),

    keyword_for: ($) => token(prec(1, kw("for"))),
    keyword_for_each: ($) => token(prec(1, kw("for each"))),
    keyword_end_for: ($) => token(prec(1, kw("end for"))),
    keyword_end_for_each: ($) => token(prec(1, kw("end for each"))),

    keyword_while: ($) => token(prec(1, kw("while"))),
    keyword_end_while: ($) => token(prec(1, kw("end while"))),

    keyword_repeat: ($) => token(prec(1, kw("repeat"))),
    keyword_until: ($) => token(prec(1, kw("until"))),

    keyword_use: ($) => token(prec(1, kw("use"))),
    keyword_end_use: ($) => token(prec(1, kw("end use"))),

    keyword_function: ($) => token(prec(1, kw("function"))),
    keyword_end_function: ($) => token(prec(1, kw("end function"))),

    keyword_class: ($) => token(prec(1, kw("class"))),
    keyword_class_constructor: ($) =>
      token(prec(1, kw("class constructor"))),
    keyword_class_extends: ($) => token(prec(1, kw("class extends"))),
    keyword_end_class: ($) => token(prec(1, kw("end class"))),
    keyword_extends: ($) => token(prec(1, kw("extends"))),

    keyword_begin_sql: ($) => token(prec(1, kw("begin sql"))),
    keyword_end_sql: ($) => token(prec(1, kw("end sql"))),

    keyword_return: ($) => token(prec(1, kw("return"))),
    keyword_break: ($) => token(prec(1, kw("break"))),
    keyword_continue: ($) => token(prec(1, kw("continue"))),
    keyword_var: ($) => token(prec(1, kw("var"))),
    keyword_this: ($) => token(prec(1, kw("this"))),
    keyword_super: ($) => token(prec(1, kw("super"))),
    keyword_new: ($) => token(prec(1, kw("new"))),
    keyword_local: ($) => token(prec(1, kw("local"))),
    keyword_shared: ($) => token(prec(1, kw("shared"))),
    keyword_get: ($) => token(prec(1, kw("get"))),
    keyword_set: ($) => token(prec(1, kw("set"))),
    keyword_try: ($) => token(prec(1, kw("try"))),
    keyword_catch: ($) => token(prec(1, kw("catch"))),
    keyword_throw: ($) => token(prec(1, kw("throw"))),
    keyword_property: ($) => token(prec(1, kw("property"))),
    keyword_alias: ($) => token(prec(1, kw("alias"))),
    keyword_formula: ($) => token(prec(1, kw("formula"))),
    keyword_true: ($) => token(prec(1, kw("true"))),
    keyword_false: ($) => token(prec(1, kw("false"))),
    keyword_null: ($) => token(prec(1, kw("null"))),
  },
});

// Helper for building case-insensitive type-keyword alternations into a
// single regex (used by C_TYPE and ARRAY keywords).
function kwordCaseInsensitive(s) {
  return s
    .split("")
    .map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)
    .join("");
}
