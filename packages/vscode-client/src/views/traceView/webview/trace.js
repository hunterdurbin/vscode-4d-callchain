// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  // ── State ──────────────────────────────────────────────────────────────────
  let root = null; // {symbolId, name, kind, ownerClass, childCount}
  const rowsById = new Map(); // nodeId -> row (+ childIds, expanded, pending)
  let rootChildIds = [];
  let categories = {}; // category -> [SymbolKind...]
  let kindToCategory = {};
  let hidden = new Set(); // hidden category ids
  let showSnippets = true;
  let nameQuery = "";
  let truncated = false;

  const CATEGORY_LABELS = {
    methods: "Project methods",
    classes: "Classes",
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
      kindToCategory = {};
      for (const [cat, kinds] of Object.entries(categories)) {
        for (const k of kinds) kindToCategory[k] = cat;
      }
      if (!document.getElementById("kindsMenu").childElementCount) {
        hidden = new Set(opts.hiddenCategories || []);
        showSnippets = !!opts.showSnippets;
        document.getElementById("snippets").checked = showSnippets;
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
    }
  });

  // ── Filtering ──────────────────────────────────────────────────────────────
  function isKindHidden(row) {
    const cat = kindToCategory[row.kind];
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
    if (!row.childIds) return false;
    return row.childIds.some((id) => {
      const c = rowsById.get(id);
      return c && !isKindHidden(c) && subtreeMatches(c);
    });
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
    line.className = "row" + (matchesName(row) && nameQuery ? " match" : "");

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
    li.appendChild(line);

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
  });

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

  vscode.postMessage({ type: "ready" });
})();
