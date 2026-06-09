# Handoff: call-graph misses `cs.<Class>.new()` instantiation & override-dispatch edges

**Filed by:** Claude (working in `~/src/4d/symphony`)
**Date:** 2026-06-09
**Component:** `packages/mcp-server` (call-graph indexer) — tools `find_instantiations`, `find_callers`, `find_overrides`
**Severity:** Medium — produces **false "dead code" negatives**. Tools report `count: 0` for symbols that are demonstrably live, which can mislead a user into deleting reachable code.

---

## Summary

For plain (non-ORDA) user classes instantiated via `cs.<Class>.new()`, the indexer fails to create two kinds of edges:

1. **Instantiation edges** — `find_instantiations` returns `count: 0` for a non-ORDA class even when `cs.<Class>.new()` is called in indexed methods. (`find_instantiations` is documented as ORDA-only, so the gap is that there is **no** tool/edge that answers "who constructs this plain class?")
2. **Polymorphic override-call edges** — `find_callers` on an *overriding* method returns `0`, because the only dynamic call site (`$var.method()`, where `$var` is typed as the **base** class) is statically attributed to the base method, never to the overrides.

Net effect: a subclass whose only entry is `cs.FourQJobManager.new().processNextJob(cs.SubJob.new())` followed by polymorphic `$job.execute()` looks completely unreferenced in the graph, when it is in fact live, scheduled batch code.

---

## Reproduction (against the `symphony` index)

Class under test: `InventorySetHiddenWebJob extends FourQueueJob`
(`Project/Sources/Classes/InventorySetHiddenWebJob.4dm`).

### Observed (buggy)

```
find_instantiations(className="InventorySetHiddenWebJob")  → { count: 0, sites: [] }
find_callers(name="execute", ownerClass="InventorySetHiddenWebJob")  → { count: 0, callers: [] }
```

### Ground truth (via grep over `Project/Sources/**/*.4dm`)

Two real instantiation sites exist:

```
Project/Sources/Methods/IW_Weblive_set.4dm:24        $jobInventorySetHiddenWeb:=cs.InventorySetHiddenWebJob.new()
Project/Sources/Methods/4Q_InventorySetHiddenWeb.4dm:8  cs.FourQJobManager.new().processNextJob(cs.InventorySetHiddenWebJob.new())
```

And `InventorySetHiddenWebJob.execute()` *is* reached at runtime via `FourQJobManager.processNextJob` line 43 (`$job.execute()`, where `$job : cs.FourQueueJob`).

### Not a one-off — same gap on 3 sibling classes

All dispatched via the identical chained pattern; all return `find_callers(execute) → 0`:

| Class | Real dispatch site (found by grep, missed by index) |
|---|---|
| `SetHoldStatusJob` | `Project/Sources/Methods/4Q_SetHoldStatus.4dm:10` |
| `GenericName_UpdateIQItemsJob` | `Project/Sources/Methods/4Q_GenericName_UpdateIQItems.4dm:8` |
| `PMP_AdjustPriceJob` | `Project/Sources/Methods/4Q_PMP_AdjustPrice.4dm:8` |

Each line is `cs.FourQJobManager.new().processNextJob(cs.<Job>.new())`.

---

## Two distinct root-cause hypotheses

### Issue A — `cs.<Class>.new()` does not create an edge to the class/constructor symbol

`find_instantiations`' own description says it exists *because* "`cs.<Entity>` / `ds.<DataClass>` forms don't edge to the class" — but it only covers **ORDA** classes (entities/selections/dataclasses). A plain class like `InventorySetHiddenWebJob` falls through: not ORDA, so `find_instantiations` ignores it, and `find_callers` on the class/constructor also finds nothing because `cs.X.new()` was never recorded as a call edge.

**Suggested fix (pick one or both):**
- Record `cs.<Class>.new()` as a call edge into that class's `Class constructor` (and/or a synthetic "instantiation" edge into the `Class` symbol), for **all** `cs.` classes, not just ORDA ones.
- Extend `find_instantiations` (or add a sibling tool / merge into `find_callers`) to resolve `cs.<Class>.new()` sites for non-ORDA classes.

**Note on chained calls:** the missed sites are inline-chained — `cs.FourQJobManager.new().processNextJob(...)` with no intermediate variable. Worth a test fixture: confirm both the outer `.new()` *and* the nested-argument `cs.X.new()` get edges. (Interestingly, `find_callers(processNextJob)` *does* resolve all 8 callers and even shows the `cs.X.new()` argument in `raw` — so method-call resolution on the receiver works; it's specifically the **constructor target** of `cs.X.new()` that isn't edged.)

### Issue B — overriding methods get no caller edge from polymorphic dispatch

`FourQJobManager.processNextJob` calls `$job.execute()` where `$job : cs.FourQueueJob`. The index correctly:
- attributes that call site to `FourQueueJob.execute` (`find_callers` → 1 caller), and
- knows the 12 overrides (`find_overrides(execute, FourQueueJob)` → 12).

But `find_callers` on any **override** (e.g. `InventorySetHiddenWebJob.execute`) returns `0`. Static type resolution to the base method is defensible, but the practical result is every override looks like dead code.

**Suggested fix:** when a call resolves to a base-class method that has known overrides, also surface the override targets — either by adding (virtual) caller edges to overrides, or by teaching `find_callers` to optionally include "inherited via base" call sites (e.g. a `includeOverridden`/`virtual: true` flag, or a note in the result). At minimum, `find_callers` on an override could fall back to reporting the base method's call sites tagged as "dispatched via base `cs.FourQueueJob.execute`".

---

## Why it matters

These two gaps compound for the very common 4D pattern of **DI + polymorphic dispatch** (a manager typed to a base class, handed `cs.Subclass.new()`). For the `FourQueueJob` family specifically, 4 of 12 subclasses are invisible to `find_callers`/`find_instantiations` despite being live scheduled batch jobs. A user trusting the graph for dead-code cleanup would wrongly conclude they're unused.

## Suggested acceptance tests

1. `find_instantiations("InventorySetHiddenWebJob")` returns the 2 sites above (or a non-ORDA equivalent tool does).
2. `find_callers(execute, ownerClass="InventorySetHiddenWebJob")` surfaces the `FourQJobManager.processNextJob:43` dispatch (directly or as "via base").
3. Inline-chained `cs.A.new().method(cs.B.new())` yields edges for both `A` and `B` constructors.
4. Regression guard: ORDA `find_instantiations` behavior unchanged.
