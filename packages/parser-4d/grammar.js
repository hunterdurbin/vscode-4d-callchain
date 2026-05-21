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
  // extras because we use it as a statement separator.
  extras: ($) => [/[ \t\r]+/, $.line_comment, $.block_comment],

  // `identifier` is the "word" token. Combined with `prec(1)` on each
  // keyword's regex, this gives us: `If` is `keyword_if`, but `IfFoo` is
  // `identifier`.
  word: ($) => $.identifier,

  conflicts: ($) => [],

  rules: {
    // ---- File structure ----

    source_file: ($) => repeat($._top_level_item),

    _top_level_item: ($) =>
      choice(
        $._declaration,
        $._misc_statement,
        $._newline,
      ),

    _newline: ($) => /\n/,

    _declaration: ($) =>
      choice(
        $.class_extends_header,
        $.class_end,
        $.constructor_declaration,
        $.function_declaration,
        $.property_declaration,
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
        field("accessor", optional(choice($.keyword_get, $.keyword_set))),
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

    // `#DECLARE($a : T; $b)` — optionally with `-> $result : Type` arrow form.
    declare_directive: ($) =>
      seq(
        $.declare_keyword,
        field("parameters", $.parameter_list),
        field("return", optional($.declare_return)),
        $._newline,
      ),

    // ` -> $result : Type` — the arrow return form unique to #DECLARE.
    declare_return: ($) =>
      seq(
        "->",
        field("name", $.local_var),
        optional(seq(":", field("type", $._type_ref))),
      ),

    // The `#DECLARE` directive keyword, distinct from the general `directive`
    // token so the parser can take the structured path.
    declare_keyword: ($) => token(prec(2, kw("#DECLARE"))),

    // ---- Catch-all for non-declaration lines (Phase 3+ refines this) ----

    // A line of arbitrary tokens — assignments, calls, expressions, control
    // flow, etc. Phase 3 will replace this with real expression rules. For
    // Phase 2, we accept any sequence of tokens terminated by newline.
    _misc_statement: ($) =>
      seq(repeat1($._misc_token), $._newline),

    _misc_token: ($) =>
      choice(
        $.identifier,
        $.local_var,
        $.parameter,
        $.interprocess_var,
        $.field_ref,
        $.table_ref,
        $.number,
        $.string,
        $.directive,
        // Operators / punctuation used in expressions.
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
        // Keywords that can appear inside expressions/statements.
        $.keyword_this,
        $.keyword_super,
        $.keyword_new,
        $.keyword_return,
        $.keyword_true,
        $.keyword_false,
        $.keyword_null,
        $.keyword_formula,
        // Control-flow keywords (caught here in Phase 2; Phase 4 structures them).
        $.keyword_if,
        $.keyword_else,
        $.keyword_end_if,
        $.keyword_else_if,
        $.keyword_case_of,
        $.keyword_end_case,
        $.keyword_for,
        $.keyword_for_each,
        $.keyword_end_for,
        $.keyword_end_for_each,
        $.keyword_while,
        $.keyword_end_while,
        $.keyword_repeat,
        $.keyword_until,
        $.keyword_use,
        $.keyword_end_use,
        $.keyword_begin_sql,
        $.keyword_end_sql,
        $.keyword_try,
        $.keyword_catch,
        $.keyword_throw,
        // Optional `End function` / `End class` in legacy code (also caught here).
        $.keyword_end_function,
      ),

    // ---- Operators ----

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
    // Single-char operators that don't need to be individually addressable yet.
    op_other: ($) => token(/[+\-*/=#<>&|^]|>=|<=/),

    // ---- Token rules (Phase 1, unchanged) ----

    identifier: ($) => /[A-Za-z_][A-Za-z0-9_]*/,
    local_var: ($) =>
      /\$[A-Za-z_][A-Za-z0-9_]*|\$\d+[A-Za-z_][A-Za-z0-9_]*/,
    parameter: ($) => /\$\d+/,
    interprocess_var: ($) => /<>[A-Za-z_][A-Za-z0-9_]*/,
    field_ref: ($) => /\[[A-Za-z_][A-Za-z0-9_]*\][A-Za-z_][A-Za-z0-9_]*/,
    table_ref: ($) => /\[[A-Za-z_][A-Za-z0-9_]*\]/,

    number: ($) =>
      choice(
        token(/0[xX][0-9a-fA-F]+/),
        token(/\d+\.\d+([eE][+-]?\d+)?/),
        token(/\d+[eE][+-]?\d+/),
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

    block_comment: ($) =>
      token(seq("/*", /([^*]|\*+[^*/])*/, /\*+\//)),

    // General-purpose directive (anything matching `#KEYWORD ...` at line
    // start that isn't the structured `#DECLARE`). #DECLARE gets prec(2) so
    // the structured path wins.
    directive: ($) =>
      choice(
        token(kw("#PROJECT METHOD")),
        token(kw("#PROPERTIES")),
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
