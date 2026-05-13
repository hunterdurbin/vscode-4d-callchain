// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  let cy;
  let currentData = { nodes: [], edges: [], rootId: null };

  const KIND_COLORS = {
    ProjectMethod:     "#4ec9b0",
    ClassFunction:     "#569cd6",
    ClassConstructor:  "#c586c0",
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

  function buildElements(data) {
    const nodes = data.nodes.map((n) => ({
      data: {
        id: n.id,
        label: n.label,
        kind: n.kind,
        ownerClass: n.ownerClass || "",
        uri: n.uri,
        line: n.line
      },
      classes: n.id === data.rootId ? "root" : ""
    }));
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
      { selector: "node.root", style: { "border-width": 3, "border-color": "#ffd700" } },
      { selector: "node.dim",  style: { opacity: 0.18 } },
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

  function applyLayout(name) {
    if (!cy) return;
    const layouts = {
      dagre:        { name: "dagre", rankDir: "LR", nodeSep: 30, rankSep: 80, edgeSep: 10 },
      cose:         { name: "cose", animate: false, padding: 30 },
      breadthfirst: { name: "breadthfirst", directed: true, padding: 30, spacingFactor: 1.2 },
      concentric:   { name: "concentric", animate: false, padding: 30, levelWidth: () => 1 }
    };
    cy.layout(layouts[name] || layouts.dagre).run();
  }

  function render(data) {
    currentData = data;
    document.getElementById("stats").textContent =
      `${data.nodes.length} nodes • ${data.edges.length} edges — root: ${data.rootLabel}`;
    if (!cy) {
      cy = cytoscape({
        container: document.getElementById("cy"),
        elements: buildElements(data),
        style: buildStyle(),
        wheelSensitivity: 0.2
      });
      cy.on("tap", "node", (evt) => {
        const id = evt.target.id();
        vscode.postMessage({ type: "openSymbol", payload: { id } });
      });
      cy.on("cxttap", "node", (evt) => {
        const id = evt.target.id();
        vscode.postMessage({ type: "setRoot", payload: { id } });
      });
    } else {
      cy.elements().remove();
      cy.add(buildElements(data));
    }
    applyLayout(document.getElementById("layout").value);
  }

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (m.type === "data") {
      render(m.payload);
    }
  });

  function emitRebuild() {
    vscode.postMessage({
      type: "rebuild",
      payload: {
        depth: Number(document.getElementById("depth").value),
        direction: document.getElementById("direction").value
      }
    });
  }

  document.getElementById("depth").addEventListener("input", (e) => {
    document.getElementById("depthVal").textContent = e.target.value;
    emitRebuild();
  });
  document.getElementById("direction").addEventListener("change", emitRebuild);
  document.getElementById("layout").addEventListener("change", () => applyLayout(document.getElementById("layout").value));
  document.getElementById("fit").addEventListener("click", () => cy && cy.fit(undefined, 30));
  document.getElementById("filter").addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const match = !q || n.data("label").toLowerCase().includes(q) || (n.data("ownerClass") || "").toLowerCase().includes(q);
        n.toggleClass("dim", !match);
      });
    });
  });

  vscode.postMessage({ type: "ready" });
})();
