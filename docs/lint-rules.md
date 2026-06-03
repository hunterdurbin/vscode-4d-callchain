# Lint Rules

The 4D Call Chain extension ships a built-in linter with eleven rules across
four themes: **types**, **decl**, **unused**, and **style**. Every rule is
**off by default** — enable the ones you want via the
`callchain.lint.rules` setting.

## Configuration shape

```jsonc
"callchain.lint.rules": {
  // Plain severity string:
  "unused/parameter": "warning",

  // Or { severity, options } for per-rule tuning:
  "unused/method-no-callers": {
    "severity": "warning",
    "options": {
      "entrypointPattern": "^(On |handle_)",
      "entrypoints": ["RPC_Public_GetUser"]
    }
  },

  "style/class-pascal-case": "error",
  "style/builtin-name-collision": "warning"
}
```

Severity must be one of: `"off"`, `"info"`, `"warning"`, `"error"`.
Any unrecognized value disables the rule.

## Inline suppression

Suppress a rule for the next line or the same line — works with all three
4D comment styles (`//`, backtick, or `/* … */`):

```4d
// lint-disable-next-line unused/parameter
Function process($unused : Text; $real : Text) : Text

If (someCondition)
  $maybeUsed:=1  // lint-disable-line unused/local
End if
```

A top-of-file comment disables a rule for the whole file:

```4d
// lint-disable style/method-camel-case
```

Use `*` to disable every rule on a line / next-line / file:

```4d
// lint-disable-next-line *
```

---

## Rule reference

### types/missing-param-type

Flag function / method / constructor parameters that don't declare a type.

```4d
// Bad — `$amount` has no type
Function discount($amount; $rate : Number) : Number
  return $amount * $rate
```

Parameters whose name starts with `_` (intentional placeholders) are
skipped.

**Options:** none.

---

### types/missing-return-type

Flag class functions and getters whose declaration is missing the
`: <Type>` return annotation. Constructors and setters are exempt
(they don't return).

```4d
// Bad — no return type
Function getName()
  return This.name
```

**Options:** none.

---

### decl/implicit-local

Flag local variables whose first appearance is an assignment with no
preceding `var`, `C_*`, or `#DECLARE` declaration. Implicit locals
work in interpreted mode but break under compilation.

```4d
// Bad — `$count` is implicit
$count:=0
For ($i; 1; 10)
  $count:=$count+1
End for
```

| Option | Default | Purpose |
|---|---|---|
| `ignoreNamePattern` | `"^_"` | Regex of names to skip (no `$` prefix) |

---

### unused/method-no-callers

Flag public project methods / class functions with zero callers anywhere
in the project. Entrypoints (form events, `On Startup`, RPC handlers)
are exempted via the `entrypointPattern` regex and the explicit
`entrypoints` allowlist.

| Option | Default | Purpose |
|---|---|---|
| `publicPattern` | `"^[^_]"` | Names matching this regex are "public" — i.e. candidates for the check |
| `entrypoints` | `[]` | Names to skip regardless of caller count |
| `entrypointPattern` | `"^On "` | Regex of names to skip (covers form events + `On Startup`) |

---

### unused/parameter

Flag declared parameters that the function body never reads. Default
ignores `^_` so `$_unused : Text` doesn't fire.

| Option | Default | Purpose |
|---|---|---|
| `ignoreNamePattern` | `"^_"` | Regex of names to skip (no `$` prefix) |

---

### unused/local

Flag local variables that are written or declared (via `var` / `C_*`)
but never read.

```4d
// Bad — `$total` is computed but never used
$total:=$a+$b
return $a
```

| Option | Default | Purpose |
|---|---|---|
| `ignoreNamePattern` | `"^_"` | Regex of names to skip (no `$` prefix) |

---

### style/class-pascal-case

Flag class names that don't match the project's casing pattern.

| Option | Default | Purpose |
|---|---|---|
| `pattern` | `"^[A-Z][A-Za-z0-9]*$"` | Regex the class name must match |

---

### style/method-camel-case

Flag method / project-method names that don't match the project's
casing pattern. Underscore-prefixed names (`_privateThing`) are allowed
by default so the "private" convention isn't penalized.

| Option | Default | Purpose |
|---|---|---|
| `pattern` | `"^[a-z][A-Za-z0-9_]*$"` | Regex the method name must match |
| `allowUnderscorePrefix` | `true` | Strip leading underscores before matching the pattern |

---

### style/missing-docstring-on-public

Flag public project methods / class functions that aren't preceded by a
comment block. The rule walks backward from the declaration line
collecting contiguous comment lines (`//`, backtick, `/* … */`) and
passes when at least `minLines` are found. A blank line breaks the
block.

```4d
// Good — leading docstring
// Compute the discount for an order.
Function discount($amount : Number; $rate : Number) : Number
  return $amount * $rate
```

| Option | Default | Purpose |
|---|---|---|
| `publicPattern` | `"^[^_]"` | Symbols matching this regex are "public" |
| `minLines` | `1` | Minimum contiguous comment lines required |
| `acceptedPrefixes` | `["//", "`", "/*"]` | Comment prefixes that count toward the block |

File-level project methods (where the body covers the whole file) are
not flagged — there's no syntactic "above declaration" location.

---

### style/builtin-name-collision

Flag user-defined symbols whose name (case-insensitive) collides with a
4D built-in command. 4D is case-insensitive for command lookup, so a
project method called `length` is treated identically to `Length` —
which makes call resolution ambiguous in legacy code.

| Option | Default | Purpose |
|---|---|---|
| `ignoreNames` | `[]` | Names to allowlist even if they collide (case-sensitive) |

---

### style/trailing-whitespace

Flag lines ending with trailing whitespace. Originally the smoke rule
for the framework; useful as a low-priority warning when included.

| Option | Default | Purpose |
|---|---|---|
| `includeTabs` | `true` | Treat trailing tabs as whitespace |

---

## Authoring tip

Lint rules ship off-by-default specifically because a fresh project
will produce thousands of warnings on the first enable. Roll rules out
one at a time and use `// lint-disable-next-line <id>` to silence the
handful of intentional exceptions before raising severity from `info`
to `warning`.
