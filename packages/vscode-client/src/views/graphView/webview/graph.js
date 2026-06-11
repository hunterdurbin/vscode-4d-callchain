// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  let cy;
  let options = null; // last options echoed by the extension host

  const KIND_COLORS = {
    ProjectMethod:     "#4ec9b0",
    ClassFunction:     "#569cd6",
    ClassConstructor:  "#c586c0",
    ClassGetter:       "#9cdcfe",
    ClassSetter:       "#dcdcaa",
    Class:             "#4fc1ff",
    DatabaseMethod:    "#ce9178",
    FormMethod:        "#d7ba7d",
    FormObjectMethod:  "#b5cea8",
    TableFormMethod:   "#d7ba7d",
    TableObjectMethod: "#b5cea8",
    Builtin:           "#808080",
    Plugin:            "#f48771",
    Unresolved:        "#f44747",
    CompilerMethod:    "#888888"
  };

  const COL_GAP = 260; // horizontal distance between tiers
  const ROW_GAP = 48;  // vertical distance between rows in a column

  function nodePosition(n) {
    const dir = n.side === "caller" ? -1 : n.side === "callee" ? 1 : 0;
    return { x: n.tier * COL_GAP * dir, y: n.row * ROW_GAP };
  }

  function buildElements(data) {
    const visited = new Set(data.visitedIds);
    const nodes = data.nodes.map((n) => {
      const classes = [];
      if (n.side === "center") classes.push("root");
      else if (n.symbolId && visited.has(n.symbolId)) classes.push("visited");
      if (n.stub) classes.push("stub");
      if (n.unreachable) classes.push("unreachable");
      return {
        data: {
          id: n.elId,
          symbolId: n.symbolId,
          label: n.label,
          kind: n.kind,
          ownerClass: n.ownerClass || "",
          hiddenLabels: (n.hiddenLabels || []).join(", ")
        },
        position: nodePosition(n),
        classes: classes.join(" ")
      };
    });
    const edges = data.edges.map((e) => ({
      data: { id: e.id, source: e.source, target: e.target, kind: e.kind, resolved: e.resolved, line: e.line },
      classes: e.unreachable ? "unreachable" : ""
    }));
    return [...nodes, ...edges];
  }

  function buildStyle() {
    return [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "background-color": (ele) => KIND_COLORS[ele.data("kind")] || "#aaa",
          color: "#fff",
          "text-outline-color": "#000",
          "text-outline-width": 1,
          "font-size": 10,
          width: "label",
          height: 22,
          shape: "round-rectangle",
          padding: "6px",
          "text-valign": "center",
          "text-halign": "center"
        }
      },
      { selector: "node.root",    style: { "border-width": 3, "border-color": "#ffd700" } },
      { selector: "node.visited", style: { "border-width": 2, "border-color": "#b180d7", "background-blacken": -0.15 } },
      { selector: "node.dim",     style: { opacity: 0.18 } },
      {
        selector: "edge",
        style: {
          width: 1.4,
          "line-color": "#888",
          "target-arrow-color": "#888",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "control-point-step-size": 24, // fans parallel call-site edges readably
          opacity: 0.7
        }
      },
      { selector: 'edge[kind = "Dynamic"]',   style: { "line-style": "dashed", "line-color": "#f48771", "target-arrow-color": "#f48771" } },
      { selector: 'edge[kind = "Inherited"]', style: { "line-style": "dotted", "line-color": "#c586c0", "target-arrow-color": "#c586c0" } },
      { selector: 'edge[resolved = false]',   style: { "line-color": "#f44747", "target-arrow-color": "#f44747" } },
      // Call-site line badge stacked at the caller end of the edge.
      {
        selector: "edge[line]",
        style: {
          "source-label": "data(line)",
          "source-text-offset": 26,
          "font-size": 8,
          color: "#ddd",
          "text-background-color": "#3c3c3c",
          "text-background-opacity": 1,
          "text-background-shape": "round-rectangle",
          "text-background-padding": 2
        }
      },
      // Gray unreachable styling comes after the kind/resolved colors so it
      // wins by last-match; dash patterns still show through.
      { selector: "node.unreachable", style: { opacity: 0.35, "background-color": "#777" } },
      { selector: "edge.unreachable", style: { opacity: 0.3, "line-color": "#777", "target-arrow-color": "#777", "source-arrow-color": "#777" } },
      // Tiny blank pass-through rect for hidden/compressed nodes.
      {
        selector: "node.stub",
        style: {
          width: 14,
          height: 10,
          label: "",
          padding: "0px",
          shape: "round-rectangle",
          "background-color": "#9a9a9a",
          "background-opacity": 0.6,
          "border-width": 0
        }
      }
    ];
  }

  // ── Options bar ───────────────────────────────────────────────────────────

  function postOptions() {
    vscode.postMessage({ type: "setOptions", payload: { options } });
  }

  function callSiteSortApplicable(o) {
    // Mirrors callSiteSortApplicable() in butterflyData.ts.
    return o.callerMode !== "graph" || o.calleeMode !== "graph" || o.dupEdges === "expand";
  }

  function syncOptionsUi(data) {
    if (!options) return;
    document.getElementById("options").hidden = options.optionsBarCollapsed;
    document.querySelectorAll(".seg").forEach((seg) => {
      const opt = seg.dataset.opt;
      const current = String(options[opt]);
      seg.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("active", b.dataset.val === current);
        b.setAttribute("aria-pressed", String(b.dataset.val === current));
        if (opt === "sort" && b.dataset.val === "callSite") b.disabled = !callSiteSortApplicable(options);
      });
    });
    const callerDepth = document.getElementById("callerDepth");
    const calleeDepth = document.getElementById("calleeDepth");
    if (document.activeElement !== callerDepth) callerDepth.value = String(options.callerDepth);
    if (document.activeElement !== calleeDepth) calleeDepth.value = String(options.calleeDepth);

    const chips = document.getElementById("chips");
    chips.textContent = "";
    for (const chip of data.classChips || []) {
      const b = document.createElement("button");
      b.className = "chip" + (chip.hidden ? " chip-off" : "") + (chip.present ? "" : " chip-absent");
      b.textContent = chip.count > 0 ? `${chip.label} (${chip.count})` : chip.label;
      b.title = chip.hidden ? "Hidden — click to show again" : "Click to hide these methods (kept as tiny pass-through stubs)";
      b.addEventListener("click", () => {
        const set = new Set(options.hiddenClasses);
        if (set.has(chip.key)) set.delete(chip.key);
        else set.add(chip.key);
        options.hiddenClasses = [...set];
        postOptions();
      });
      chips.appendChild(b);
    }
    if ((data.classChips || []).length === 0) {
      const none = document.createElement("span");
      none.className = "chips-empty";
      none.textContent = "—";
      chips.appendChild(none);
    }
  }

  function wireOptionControls() {
    document.querySelectorAll(".seg").forEach((seg) => {
      const opt = seg.dataset.opt;
      seg.querySelectorAll("button").forEach((b) => {
        b.addEventListener("click", () => {
          if (!options) return;
          const raw = b.dataset.val;
          options[opt] = raw === "true" ? true : raw === "false" ? false : raw;
          syncOptionsUi({ classChips: lastChips });
          postOptions();
        });
      });
    });
    let depthTimer;
    for (const id of ["callerDepth", "calleeDepth"]) {
      document.getElementById(id).addEventListener("input", (e) => {
        if (!options) return;
        const v = Math.min(6, Math.max(1, Number(e.target.value) || 1));
        options[id] = v;
        clearTimeout(depthTimer);
        depthTimer = setTimeout(postOptions, 150);
      });
    }
    document.getElementById("optionsToggle").addEventListener("click", () => {
      if (!options) return;
      options.optionsBarCollapsed = !options.optionsBarCollapsed;
      document.getElementById("options").hidden = options.optionsBarCollapsed;
      postOptions(); // collapse-only changes persist without a rebuild
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  let lastChips = [];

  function render(data) {
    options = data.options;
    lastChips = data.classChips || [];
    document.getElementById("stats").textContent =
      `${data.nodes.length} nodes • ${data.edges.length} edges — center: ${data.centerLabel}`;
    document.getElementById("back").disabled = !data.canGoBack;
    document.getElementById("forward").disabled = !data.canGoForward;
    document.getElementById("truncated").hidden = !data.truncated;
    syncOptionsUi(data);

    if (!cy) {
      cy = cytoscape({
        container: document.getElementById("cy"),
        elements: buildElements(data),
        style: buildStyle(),
        layout: { name: "preset" },
        wheelSensitivity: 0.2
      });
      // Single click re-centers; double click opens the symbol in the editor.
      // cytoscape's "onetap" only fires when no second tap follows, so the
      // two gestures never both trigger. Stubs carry no symbolId — no-ops.
      cy.on("onetap", "node", (evt) => {
        const symbolId = evt.target.data("symbolId");
        if (symbolId) vscode.postMessage({ type: "recenter", payload: { symbolId } });
      });
      cy.on("dbltap", "node", (evt) => {
        const symbolId = evt.target.data("symbolId");
        if (symbolId) vscode.postMessage({ type: "openSymbol", payload: { symbolId } });
      });
    } else {
      cy.elements().remove();
      cy.add(buildElements(data));
      cy.layout({ name: "preset" }).run();
    }
    applyFilter();
    cy.fit(undefined, 30);
  }

  function applyFilter() {
    if (!cy) return;
    const q = document.getElementById("filter").value.toLowerCase();
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        if (n.hasClass("stub")) return; // stubs stay as-is, they have no label
        const match = !q || n.data("label").toLowerCase().includes(q) || (n.data("ownerClass") || "").toLowerCase().includes(q);
        n.toggleClass("dim", !match);
      });
    });
  }

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "data") {
      render(m.payload);
    }
  });

  document.getElementById("back").addEventListener("click", () => vscode.postMessage({ type: "back" }));
  document.getElementById("forward").addEventListener("click", () => vscode.postMessage({ type: "forward" }));
  document.getElementById("clearTrail").addEventListener("click", () => vscode.postMessage({ type: "clearTrail" }));
  document.getElementById("fit").addEventListener("click", () => cy && cy.fit(undefined, 30));
  document.getElementById("filter").addEventListener("input", applyFilter);
  wireOptionControls();

  vscode.postMessage({ type: "ready" });
})();
