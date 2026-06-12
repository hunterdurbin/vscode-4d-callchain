// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  // ── State ──────────────────────────────────────────────────────────────────
  let root = null; // {symbolId, name, kind, ownerClass, childCount}
  const rowsById = new Map(); // nodeId -> row (+ childIds, expanded, pending)
  let rootChildIds = [];
  let categories = {}; // category -> {kinds: [SymbolKind...], access?: "read"|"write"}
  let hidden = new Set(); // hidden category ids
  let showSnippets = true;
  let nameQuery = "";
  let truncated = false;

  const CATEGORY_LABELS = {
    methods: "Project methods",
    classConstructors: "Constructors",
    classFunctions: "Class functions",
    classGetters: "Getters",
    classSetters: "Setters",
    propertyReads: "Property reads",
    propertyWrites: "Property writes",
    forms: "Forms",
    builtins: "Built-ins",
    constants: "Constants",
    variables: "Variables",
    plugins: "Plugins",
    components: "Components",
    unresolved: "Unresolved"
  };

  // ── Data intake ────────────────────────────────────────────────────────────
  function adoptRows(rows) {
    const ids = [];
    for (const r of rows) {
      r.childIds = r.children ? adoptRows(r.children) : null; // null = not loaded
      r.expanded = !!r.children;
      delete r.children;
      r.altIds = r.alternatives ? adoptRows(r.alternatives) : [];
      delete r.alternatives;
      rowsById.set(r.nodeId, r);
      ids.push(r.nodeId);
    }
    return ids;
  }

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "root") {
      rowsById.clear();
      root = m.payload.root;
      const opts = m.payload.options;
      categories = opts.categories || {};
      if (!document.getElementById("kindsMenu").childElementCount) {
        hidden = new Set(opts.hiddenCategories || []);
        showSnippets = !!opts.showSnippets;
        document.getElementById("snippets").checked = showSnippets;
        document.getElementById("depthSel").value = String(opts.expandDepth || 1);
        buildKindsMenu();
      }
      truncated = !!opts.truncated;
      rootChildIds = adoptRows(m.payload.children || []);
      render();
    } else if (m.type === "children") {
      const parent = rowsById.get(m.payload.nodeId);
      if (!parent) return;
      parent.childIds = adoptRows(m.payload.children || []);
      parent.expanded = true;
      parent.pending = false;
      if (m.payload.truncated) truncated = true;
      render();
    } else if (m.type === "overrides") {
      const parent = rowsById.get(m.payload.nodeId);
      if (!parent) return;
      // Dedupe against alternatives that are already showing.
      const existing = new Set((parent.altIds || []).map((id) => rowsById.get(id)?.calleeId));
      const fresh = (m.payload.rows || []).filter((r) => !existing.has(r.calleeId));
      const ids = adoptRows(fresh);
      parent.altIds = [...(parent.altIds || []), ...ids];
      parent.injectedAltIds = ids;
      render();
    } else if (m.type === "defaultsSaved") {
      const btn = document.getElementById("saveDefaults");
      const original = btn.textContent;
      btn.textContent = "Saved ✓";
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 1200);
    }
  });

  // ── Filtering ──────────────────────────────────────────────────────────────
  /** The category a row belongs to: kind match first, then the access
   *  dimension for read/write-split categories (default read when untagged). */
  function categoryOf(row) {
    for (const [cat, def] of Object.entries(categories)) {
      if (!def.kinds.includes(row.kind)) continue;
      if (def.access && (row.access || "read") !== def.access) continue;
      return cat;
    }
    return undefined;
  }

  function isKindHidden(row) {
    const cat = categoryOf(row);
    return cat ? hidden.has(cat) : false;
  }

  function matchesName(row) {
    if (!nameQuery) return true;
    const owner = row.ownerClass ? row.ownerClass.toLowerCase() : "";
    return row.name.toLowerCase().includes(nameQuery) || owner.includes(nameQuery);
  }

  /** True if the row or any LOADED descendant matches the name filter. */
  function subtreeMatches(row) {
    if (matchesName(row)) return true;
    const scan = (ids) =>
      (ids || []).some((id) => {
        const c = rowsById.get(id);
        return c && !isKindHidden(c) && subtreeMatches(c);
      });
    return scan(row.childIds) || scan(row.altIds);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  let visibleCount = 0;

  function render() {
    const tree = document.getElementById("tree");
    tree.textContent = "";
    visibleCount = 0;
    if (!root) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Symbol not found — it may have been removed by a reindex.";
      tree.appendChild(empty);
      return;
    }
    tree.appendChild(renderRootRow());
    const ul = document.createElement("ul");
    for (const id of rootChildIds) {
      const li = renderRow(rowsById.get(id));
      if (li) ul.appendChild(li);
    }
    tree.appendChild(ul);
    document.getElementById("truncated").hidden = !truncated;
    document.getElementById("stats").textContent =
      `${visibleCount} of ${rowsById.size} call sites shown`;
  }

  function renderRootRow() {
    const div = document.createElement("div");
    div.className = "row root-row";
    div.appendChild(kindDot(root.kind));
    div.appendChild(nameSpan(root.ownerClass, root.name));
    const count = document.createElement("span");
    count.className = "meta";
    count.textContent = `${root.childCount} calls`;
    div.appendChild(count);
    div.addEventListener("click", () => {
      vscode.postMessage({ type: "setRoot", payload: { symbolId: root.symbolId } });
    });
    div.addEventListener("contextmenu", (ev) => showContextMenu(ev, rootMenuItems()));
    return div;
  }

  function kindDot(kind) {
    const dot = document.createElement("span");
    dot.className = `dot k-${kind}`;
    dot.title = kind;
    return dot;
  }

  function nameSpan(ownerClass, name) {
    const span = document.createElement("span");
    span.className = "name";
    span.textContent = ownerClass ? `${ownerClass}.${name}` : name;
    return span;
  }

  function renderRow(row) {
    if (!row || isKindHidden(row) || !subtreeMatches(row)) return null;
    visibleCount++;

    const li = document.createElement("li");
    const line = document.createElement("div");
    line.className =
      "row" +
      (matchesName(row) && nameQuery ? " match" : "") +
      (row.isAlternative ? " alternative" : "");

    if (row.isAlternative) {
      const badge = document.createElement("span");
      badge.className = "may-run-badge";
      badge.textContent = "↪ may run";
      badge.title = "Possible dispatch target — a subclass overrides this member";
      line.appendChild(badge);
    }

    const twistie = document.createElement("span");
    twistie.className = "twistie";
    if (row.recursive) {
      twistie.textContent = "↻";
      twistie.title = "Recursive call — already in this chain";
      twistie.classList.add("recursion");
    } else if (row.childCount === 0) {
      twistie.textContent = "·";
      twistie.classList.add("leaf");
    } else {
      twistie.textContent = row.pending ? "…" : row.expanded ? "▾" : "▸";
      twistie.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggle(row);
      });
    }
    line.appendChild(twistie);
    line.appendChild(kindDot(row.kind));
    line.appendChild(nameSpan(row.ownerClass, row.name));

    if (row.dispatched) {
      const badge = document.createElement("span");
      badge.className = "meta dispatch-badge";
      badge.textContent = `via ${row.receiverClass || "?"}`;
      badge.title = `Statically ${row.staticLabel || "?"} — re-resolved against the concrete receiver class`;
      line.appendChild(badge);
    }
    if (row.overrideCount) {
      const badge = document.createElement("span");
      badge.className = "meta override-badge";
      badge.textContent = `⇣${row.overrideCount}`;
      badge.title =
        `${row.overrideCount} subclass override${row.overrideCount === 1 ? "" : "s"} exist — ` +
        `not the determined target for this trace's receiver, but other call paths can reach them`;
      line.appendChild(badge);
    }

    const lineNo = document.createElement("span");
    lineNo.className = "meta";
    lineNo.textContent = `:${row.line + 1}`;
    line.appendChild(lineNo);

    if (row.access) {
      const access = document.createElement("span");
      access.className = "meta access";
      access.textContent = row.access;
      line.appendChild(access);
    }
    if (!row.resolved) {
      const badge = document.createElement("span");
      badge.className = "meta unresolved-badge";
      badge.textContent = "unresolved";
      line.appendChild(badge);
    }
    if (showSnippets && row.raw) {
      const code = document.createElement("code");
      code.className = "snippet";
      code.textContent = row.raw;
      line.appendChild(code);
    }

    const def = document.createElement("button");
    def.className = "def-btn";
    def.textContent = "⤷ def";
    def.title = "Open the callee's definition";
    def.addEventListener("click", (ev) => {
      ev.stopPropagation();
      vscode.postMessage({ type: "openDefinition", payload: { nodeId: row.nodeId } });
    });
    line.appendChild(def);

    line.addEventListener("click", () => {
      vscode.postMessage({ type: "openCallSite", payload: { nodeId: row.nodeId } });
    });
    line.addEventListener("contextmenu", (ev) => showContextMenu(ev, rowMenuItems(row)));
    li.appendChild(line);

    // "May run" alternatives sit directly under the call row, always visible
    // (the twistie governs only the static target's children).
    if (row.altIds && row.altIds.length) {
      const ul = document.createElement("ul");
      ul.className = "alts";
      for (const id of row.altIds) {
        const altLi = renderRow(rowsById.get(id));
        if (altLi) ul.appendChild(altLi);
      }
      if (ul.childElementCount) li.appendChild(ul);
    }

    if (row.expanded && row.childIds && row.childIds.length) {
      const ul = document.createElement("ul");
      for (const id of row.childIds) {
        const childLi = renderRow(rowsById.get(id));
        if (childLi) ul.appendChild(childLi);
      }
      if (ul.childElementCount) li.appendChild(ul);
    }
    return li;
  }

  function toggle(row) {
    if (row.recursive || row.pending) return;
    if (row.childIds === null) {
      row.pending = true;
      vscode.postMessage({ type: "expand", payload: { nodeId: row.nodeId } });
      render();
      return;
    }
    row.expanded = !row.expanded;
    render();
  }

  // ── Context menu ───────────────────────────────────────────────────────────
  function hideContextMenu() {
    document.getElementById("ctxMenu").hidden = true;
  }

  /** items: array of {label, run} or "—" separators. */
  function showContextMenu(ev, items) {
    ev.preventDefault();
    ev.stopPropagation();
    const menu = document.getElementById("ctxMenu");
    menu.textContent = "";
    for (const item of items) {
      if (item === "—") {
        const sep = document.createElement("div");
        sep.className = "sep";
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement("button");
      btn.textContent = item.label;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        hideContextMenu();
        item.run();
      });
      menu.appendChild(btn);
    }
    // Unhide off-screen to measure, then clamp to the viewport.
    menu.style.left = "-9999px";
    menu.style.top = "0px";
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(ev.clientX, window.innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(ev.clientY, window.innerHeight - r.height - 4))}px`;
  }

  function sameSymbolRows(calleeId) {
    return [...rowsById.values()].filter((r) => r.calleeId === calleeId);
  }

  function expandAllSame(calleeId) {
    for (const r of sameSymbolRows(calleeId)) {
      if (r.recursive || r.childCount === 0) continue;
      if (r.childIds === null) {
        if (!r.pending) {
          r.pending = true;
          vscode.postMessage({ type: "expand", payload: { nodeId: r.nodeId } });
        }
      } else {
        r.expanded = true;
      }
    }
    render();
  }

  function collapseAllSame(calleeId) {
    for (const r of sameSymbolRows(calleeId)) r.expanded = false;
    render();
  }

  function hideOverrides(row) {
    const injected = new Set(row.injectedAltIds || []);
    row.altIds = (row.altIds || []).filter((id) => !injected.has(id));
    row.injectedAltIds = undefined;
    render();
  }

  function rowMenuItems(row) {
    const items = [];
    if (row.injectedAltIds && row.injectedAltIds.length) {
      items.push({ label: "Hide overrides", run: () => hideOverrides(row) });
    } else if (row.overrideCount) {
      items.push({
        label: `Show ${row.overrideCount} override${row.overrideCount === 1 ? "" : "s"}`,
        run: () => vscode.postMessage({ type: "showOverrides", payload: { nodeId: row.nodeId } })
      });
    }
    const same = sameSymbolRows(row.calleeId);
    if (same.length > 1) {
      const display = row.ownerClass ? `${row.ownerClass}.${row.name}` : row.name;
      items.push({ label: `Expand all ${display} calls (${same.length})`, run: () => expandAllSame(row.calleeId) });
      items.push({ label: `Collapse all ${display} calls`, run: () => collapseAllSame(row.calleeId) });
    }
    if (items.length) items.push("—");
    items.push({
      label: "Trace from here",
      run: () => vscode.postMessage({ type: "setRoot", payload: { symbolId: row.calleeId } })
    });
    items.push({
      label: "Open definition",
      run: () => vscode.postMessage({ type: "openDefinition", payload: { nodeId: row.nodeId } })
    });
    items.push({
      label: "Open call site",
      run: () => vscode.postMessage({ type: "openCallSite", payload: { nodeId: row.nodeId } })
    });
    items.push("—");
    const cat = categoryOf(row);
    if (cat) {
      items.push({
        label: `Hide ${(CATEGORY_LABELS[cat] || cat).toLowerCase()}`,
        run: () => {
          hidden.add(cat);
          buildKindsMenu();
          render();
        }
      });
    }
    items.push({ label: "Copy name", run: () => vscode.postMessage({ type: "copy", payload: { text: row.name } }) });
    if (row.ownerClass) {
      items.push({
        label: "Copy qualified name",
        run: () => vscode.postMessage({ type: "copy", payload: { text: `${row.ownerClass}.${row.name}` } })
      });
    }
    return items;
  }

  function rootMenuItems() {
    const qualified = root.ownerClass ? `${root.ownerClass}.${root.name}` : root.name;
    const items = [
      {
        label: "Open definition",
        run: () => vscode.postMessage({ type: "openSymbolById", payload: { symbolId: root.symbolId } })
      },
      "—",
      { label: "Copy name", run: () => vscode.postMessage({ type: "copy", payload: { text: root.name } }) }
    ];
    if (root.ownerClass) {
      items.push({ label: "Copy qualified name", run: () => vscode.postMessage({ type: "copy", payload: { text: qualified } }) });
    }
    return items;
  }

  // ── Toolbar ────────────────────────────────────────────────────────────────
  function buildKindsMenu() {
    const menu = document.getElementById("kindsMenu");
    menu.textContent = "";
    for (const cat of Object.keys(categories)) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !hidden.has(cat);
      cb.addEventListener("change", () => {
        if (cb.checked) hidden.delete(cat);
        else hidden.add(cat);
        render();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(CATEGORY_LABELS[cat] || cat));
      menu.appendChild(label);
    }
  }

  document.getElementById("kindsBtn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    const menu = document.getElementById("kindsMenu");
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", (ev) => {
    const menu = document.getElementById("kindsMenu");
    if (!menu.hidden && !menu.contains(ev.target)) menu.hidden = true;
    hideContextMenu();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hideContextMenu();
  });
  document.addEventListener("contextmenu", (ev) => {
    // Right-click anywhere outside a row dismisses an open menu (row
    // handlers stopPropagation, so this never fires for them).
    if (!document.getElementById("ctxMenu").hidden) {
      ev.preventDefault();
      hideContextMenu();
    }
  });
  window.addEventListener("scroll", hideContextMenu, true);

  document.getElementById("filter").addEventListener("input", (e) => {
    nameQuery = e.target.value.toLowerCase();
    render();
  });
  document.getElementById("snippets").addEventListener("change", (e) => {
    showSnippets = e.target.checked;
    render();
  });
  document.getElementById("expandBtn").addEventListener("click", () => {
    const depth = Number(document.getElementById("depthSel").value);
    vscode.postMessage({ type: "expandToDepth", payload: { depth } });
  });
  document.getElementById("saveDefaults").addEventListener("click", () => {
    vscode.postMessage({
      type: "saveDefaults",
      payload: {
        hiddenKinds: [...hidden],
        showSnippets,
        expandDepth: Number(document.getElementById("depthSel").value)
      }
    });
  });

  vscode.postMessage({ type: "ready" });
})();
