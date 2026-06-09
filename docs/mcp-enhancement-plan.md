# MCP enhancement plan — call-graph gaps surfaced during entity-class exploration

Source: a session (2026-06-09) exploring `EasyPay_AgreementsEntity` in the symphony
project through the `4d-callchain-symphony` MCP. Each item below is grounded in a real
gap hit during that session, with repro evidence and file pointers. Effort scale matches
`TODO.md` (XS < 30 min · S ~1 hr · M ~half-day · L ~1–2 days · XL multi-day).

Ordered by value. Items 1 and 2 are the high-impact ones; 3–5 are correctness/coverage
follow-ups.

---

## 1. "List a class's members" capability — **M**

**Problem.** There is no way to enumerate the API of a class through the MCP. To list the
members of `EasyPay_AgreementsEntity` I had to `Read` the `.4dm` file. Specifically:

- `search_symbols` only matches on the symbol **name**, so it surfaces a member only if
  the query string happens to appear in that member's name (e.g. searching `"EasyPay"`
  returned `getUnpaidEasyPaymentRecords` but none of `initNewAgreement`,
  `setAgreementAsFullyPaid`, `writeOffAgreement`, `clearAllFields`, `isAgreementActive`).
- `get_symbol` on the class returns `callerCount: 0 / calleeCount: 0` and no member list.
- `class_hierarchy` returns ancestors/subclasses/descendants but **not** the class's own
  functions, getters, setters, or constructor.

**The data is already there.** `SymbolRecord.ownerClass` is populated for every class
member (`packages/core/src/model/symbol.ts:64`), and `model/overrides.ts` already filters
`graph.allSymbols()` by `ownerClass` (see `overridesForClass`). A member list is a
one-pass filter.

**Proposed change.** Either (preferred) add a `class_members` MCP tool, or fold a
`members` array into `class_hierarchy` and/or `get_symbol` when the target is a `Class`.

- New query in `packages/mcp-server/src/queries.ts`, e.g.:
  ```ts
  export function classMembers(graph, projectRoot, className) {
    const cls = graph.byName(className).find((s) => s.kind === SymbolKind.Class);
    if (!cls) return { error: `No class named "${className}" found.` };
    const lower = className.toLowerCase();
    const members = graph.allSymbols()
      .filter((s) => s.ownerClass?.toLowerCase() === lower)
      .sort((a, b) => a.location.line - b.location.line)
      .map((s) => ({ ...summarize(s, projectRoot),
                     callerCount: graph.callers(s.id).length,
                     calleeCount: graph.callees(s.id).length }));
    return { class: summarize(cls, projectRoot), count: members.length, members };
  }
  ```
- Register it in `packages/mcp-server/src/tools.ts` alongside `class_hierarchy`.
- Include the `scope` (`local`/`shared`/`public`) and `accessor` (`get`/`set`/`function`)
  fields already on `SymbolRecord` so callers can see at a glance what's exposed vs `local`.

**Acceptance.** `class_members EasyPay_AgreementsEntity` returns all 7 members
(constructor if any, `initNewAgreement`, `setAgreementAsFullyPaid`, `writeOffAgreement`,
`clearAllFields`, `isAgreementActive` getter, `isAgreementActive` query function,
`getUnpaidEasyPaymentRecords`) with their kinds, scopes, line numbers, and caller counts —
no file read required.

---

## 2. `find_callees` returns duplicate edges — **S**

**Problem (repro).** `find_callees` on
`EasyPay_AgreementsEntity.getUnpaidEasyPaymentRecords` returned `count: 12`, but they are
6 unique edges each listed **twice**: `ds.Payments.query` ×2 and each of
`_Payments__InvoiceID`, `_Payments__Authorize`, `_Payments__Dated`,
`_Payments__ChargeOnDate`, `_Payments__Amount` ×2 — identical `callLine`, `raw`, and
`resolved` on each pair.

The body is a single multi-line `ds.Payments.query(...)` continued with `\` across lines
51–56. The duplication almost certainly comes from the call/constant extractor emitting one
`CallEdge` per spanned source line (or two passes over the continued statement). It
inflates `calleeCount` and clutters output.

**Where.** `CallGraph.callees()` (`packages/core/src/model/callGraph.ts:43`) just returns
`this.forward.get(id)` verbatim — the dupes are produced upstream at edge-build time.

**Two fix levels:**
- **Root fix (preferred):** dedupe edges where they're constructed — look at the
  backslash-continuation handling in the extractor (`packages/core/src/indexer/`
  `fileParser.ts` / `callExtractor.ts` / `nameResolver.ts`) so a continued statement emits
  one edge per (toId, callLine, callColumn). Bump `INDEX_VERSION` if the on-disk edge set
  changes.
- **Cheap guard:** dedupe at query time in `findCallees`/`findCallers`
  (`packages/mcp-server/src/queries.ts:94`) by a `(toId|fromId, callLine, callColumn)` key
  before slicing. Safe, no index version bump, but masks the underlying double-count in
  `calleeCount`.

Do the root fix if the extractor is the cause; otherwise ship the query-time guard.

**Acceptance.** `find_callees getUnpaidEasyPaymentRecords` returns `count: 6` with each
edge once; add a mini-4d fixture with a `\`-continued multi-call statement and a
`// LOCKS:` header pinning the dedup (see `test/fixtures/mini-4d/`).

---

## 3. Entity ↔ dataclass instantiation isn't linked — **M**

**Problem.** `get_symbol EasyPay_AgreementsEntity` reports `callerCount: 0`. The class is
in fact used heavily — via `cs.EasyPay_AgreementsEntity` typed returns, `ds.EasyPay_Agreements`
dataclass queries, and `.new()` — but none of those reference forms link back to the
`Class` symbol, so "where is this entity instantiated / where is its dataclass used" is
unanswerable today.

`ClassFlavor.DataClass` / `Entity` / `EntitySelection` already exist
(`packages/core/src/model/symbol.ts:29`), so the model knows these are ORDA classes; the
missing piece is edges from `cs.<Class>.new()` / `ds.<DataClass>` references to the class
symbol.

**Proposed change.** During resolution (`packages/core/src/indexer/nameResolver.ts`), emit
a (Dynamic or new `Instantiation`) edge to the `Class` symbol when a call site references
`cs.<ClassName>` (constructor/typed `.new()`) and, for entity classes, associate
`ds.<DataClassName>` query/CRUD sites with the owning dataclass. Surface via existing
`find_callers` on the class, or a dedicated `find_instantiations` tool.

**Acceptance.** `find_callers EasyPay_AgreementsEntity` (or `find_instantiations`) returns
the production sites that create/return the entity, not an empty list.

---

## 4. Computed-attribute query functions and `Alias` attributes aren't first-class — **S–M**

**Problem.** Two ORDA constructs are invisible or ambiguous in the index:

- **`Function query isAgreementActive`** (the optimized-query backer for the
  `isAgreementActive` computed attribute) is indexed as a plain `ClassFunction`. It shares
  its name with the `ClassGetter` of the same name, so `get_symbol isAgreementActive`
  returns an "ambiguous selector" with two candidates and no hint that one *is the query
  implementation of the other*. Same applies to `Function get` / `Function set` /
  `Function orderBy` triplets backing one computed attribute.
- **`Alias invoiceId invoice.InvoiceID`** (line 5 of the class) produces no symbol at all.
  Alias attributes are queryable/where-usable like fields but can't be looked up.

**Proposed change.**
- Tag computed-attribute support functions: add an `accessor`-style marker (e.g.
  `accessor: "query" | "orderBy"`, or a `computedFor: "<attrName>"` field) on
  `SymbolRecord` so the query/orderBy functions are linked to the attribute they back, and
  `get_symbol` can disambiguate by role instead of just kind.
- Index `Alias` as its own `SymbolKind.Alias` (or a property symbol) carrying its target
  path (`invoice.InvoiceID`) so it's discoverable and its target relation is navigable.

Parsing happens in `packages/parser-4d` (tree-sitter grammar) + `packages/core/src/indexer`.
Bump `INDEX_VERSION`.

**Acceptance.** `get_symbol isAgreementActive` distinguishes the getter from its query
function by role; `search_symbols invoiceId` returns the alias with its `invoice.InvoiceID`
target.

---

## 5. Constant symbols have a stub location — **XS**

**Problem.** Every `_Payments__*` constant resolves to
`Resources/Constants_Sweetwater.xlf` **line 1**. The bogus line makes the `file:line` link
useless for jumping to a constant's definition.

**Proposed change.** When parsing `Resources/Constants_*.xlf`, capture the real line of
each `<trans-unit>` / constant entry and store it in the `Constant` symbol's
`location.line` (the watcher already covers these files per TODO #10). If exact line
capture isn't feasible from the XLF structure, document the limitation in the constant
scanner and have `summarize()` omit the misleading `:1` rather than emit it.

**Acceptance.** `find_callees getUnpaidEasyPaymentRecords` shows each constant at its
actual line in `Constants_Sweetwater.xlf`, or with no spurious line.

---

## Notes / non-issues observed (working well — leave as-is)

- Getter-vs-query **kind disambiguation** is correct: the same-named members surface as
  distinct `ClassGetter` vs `ClassFunction` with a clear ambiguous-selector error listing
  both candidate ids. (Item 4 only asks to add the *role* link, not change this.)
- **Resolution through typed locals** is solid: `$agreement.getUnpaidEasyPaymentRecords()`,
  `This.agreement.x`, and `$result.isAgreementActive` (getter access) all came back
  `resolved: true` with the correct concrete owner class.
- `find_callers` correctly separates production callers (`FlexPay_VerifyAndChargePmt`,
  `Invoices_bQuickAuth`, `EasyPay_CancelAgreementIfNeeded`, `Invoices_EasyPayWriteoff`,
  `4Q_EasyPayDisclosureAccepted`) from test callers — no false positives from comments or
  compiler declarations.
