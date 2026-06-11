// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  let cy;

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
    return {
      x: n.tier * COL_GAP * dir,
      y: n.side === "center" ? 0 : (n.order - (n.colCount - 1) / 2) * ROW_GAP
    };
  }

  function buildElements(data) {
    const visited = new Set(data.visitedIds);
    const nodes = data.nodes.map((n) => {
      const classes = [];
      if (n.side === "center") classes.push("root");
      else if (visited.has(n.symbolId)) classes.push("visited");
      return {
        data: {
          id: n.elId,
          symbolId: n.symbolId,
          label: n.label,
          kind: n.kind,
          ownerClass: n.ownerClass || ""
        },
        position: nodePosition(n),
        classes: classes.join(" ")
      };
    });
    const edges = data.edges.map((e) => ({
      data: { id: e.id, source: e.source, target: e.target, kind: e.kind, resolved: e.resolved }
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
          opacity: 0.7
        }
      },
      { selector: 'edge[kind = "Dynamic"]',   style: { "line-style": "dashed", "line-color": "#f48771", "target-arrow-color": "#f48771" } },
      { selector: 'edge[kind = "Inherited"]', style: { "line-style": "dotted", "line-color": "#c586c0", "target-arrow-color": "#c586c0" } },
      { selector: 'edge[resolved = false]',   style: { "line-color": "#f44747", "target-arrow-color": "#f44747" } }
    ];
  }

  function render(data) {
    document.getElementById("stats").textContent =
      `${data.nodes.length} nodes • ${data.edges.length} edges — center: ${data.centerLabel}`;
    document.getElementById("back").disabled = !data.canGoBack;
    document.getElementById("forward").disabled = !data.canGoForward;
    document.getElementById("truncated").hidden = !data.truncated;
    const depthEl = document.getElementById("depth");
    if (Number(depthEl.value) !== data.depth) {
      depthEl.value = String(data.depth);
      document.getElementById("depthVal").textContent = String(data.depth);
    }

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
      // two gestures never both trigger.
      cy.on("onetap", "node", (evt) => {
        vscode.postMessage({ type: "recenter", payload: { symbolId: evt.target.data("symbolId") } });
      });
      cy.on("dbltap", "node", (evt) => {
        vscode.postMessage({ type: "openSymbol", payload: { symbolId: evt.target.data("symbolId") } });
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

  document.getElementById("depth").addEventListener("input", (e) => {
    document.getElementById("depthVal").textContent = e.target.value;
    vscode.postMessage({ type: "setDepth", payload: { depth: Number(e.target.value) } });
  });
  document.getElementById("back").addEventListener("click", () => vscode.postMessage({ type: "back" }));
  document.getElementById("forward").addEventListener("click", () => vscode.postMessage({ type: "forward" }));
  document.getElementById("clearTrail").addEventListener("click", () => vscode.postMessage({ type: "clearTrail" }));
  document.getElementById("fit").addEventListener("click", () => cy && cy.fit(undefined, 30));
  document.getElementById("filter").addEventListener("input", applyFilter);

  vscode.postMessage({ type: "ready" });
})();
