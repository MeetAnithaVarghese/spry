// index.js
// Graph-centric viewer for Spry Graph Viewer UI.
// Renders relationships either as trees (hierarchical) or edge tables (flat),
// and shows node details + mdast/source when a node is selected.

let model = null;

/** @type {string | null} */
let currentDocumentId = null;
/** @type {string | null} */
let currentRelationshipName = null;
/** @type {string | null} */
let currentNodeId = null;

// Cached DOM references
const dom = {};

/**
 * Load GraphViewerModel JSON.
 * 1. Try inline JSON in #web-ui.model.json (production).
 * 2. Fallback to fetching ./fixture.model.json (design time).
 */
async function loadModel() {
  const prodScript = document.getElementById("web-ui.model.json");
  if (prodScript) {
    const text = (prodScript.textContent || "").trim();
    if (text) {
      return JSON.parse(text);
    }
  }

  const fixtureScript = document.getElementById("web-ui-fixture.model.json");
  const url = fixtureScript && fixtureScript.getAttribute("src")
    ? fixtureScript.getAttribute("src")
    : "./fixture.model.json";

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load fixture model JSON from ${url}`);
  }
  return res.json();
}

/**
 * Initialize DOM references and global event handlers.
 */
function initDom() {
  dom.title = document.getElementById("web-ui-title");
  dom.footerYear = document.getElementById("footer-year");
  dom.footerVersion = document.getElementById("footer-version");

  dom.documentSelect = document.getElementById("document-select");
  dom.documentList = document.getElementById("document-list");

  dom.relationshipList = document.getElementById("relationship-list");
  dom.relationshipModeHint = document.getElementById("relationship-mode-hint");
  dom.relationshipTitle = document.getElementById("relationship-title");
  dom.relationshipMeta = document.getElementById("relationship-meta");

  dom.hierarchyView = document.getElementById("hierarchy-view");
  dom.hierarchyRoot = document.getElementById("hierarchy-root");

  dom.edgeTableView = document.getElementById("edge-table-view");
  dom.edgeTableBody = document.querySelector("#edge-table tbody");

  dom.nodeType = document.getElementById("node-type");
  dom.nodeLabel = document.getElementById("node-label");
  dom.nodeRelationships = document.getElementById("node-relationships");
  dom.nodePath = document.getElementById("node-path");

  dom.nodeMdastJson = document.getElementById("node-mdast-json");
  dom.nodeMdastJsonCode = dom.nodeMdastJson
    ? dom.nodeMdastJson.querySelector("code")
    : null;

  dom.nodeSourceCodeInner = document.getElementById("node-source-code-inner");
}

/**
 * Bootstrap once DOM is ready.
 */
async function main() {
  initDom();

  try {
    model = await loadModel();
  } catch (err) {
    console.error("Failed to load graph model:", err);
    alert("Unable to load graph model. See console for details.");
    return;
  }

  // Basic header/footer info
  if (dom.title && model.title) {
    dom.title.textContent = model.title;
  }
  if (dom.footerYear) {
    dom.footerYear.textContent = new Date().getFullYear().toString();
  }
  if (dom.footerVersion) {
    dom.footerVersion.textContent = model.appVersion || "";
  }

  initDocuments();
  initRelationships();
  wireGlobalEvents();

  // Default selections
  if (model.documents.length > 0) {
    currentDocumentId = model.documents[0].id;
  }
  if (model.relationships.length > 0) {
    currentRelationshipName = model.relationships[0].name;
  }

  renderDocuments();
  renderRelationships();
  renderCurrentRelationshipView();
  clearNodeDetails();
}

/**
 * Initialize document selector and list from model.documents.
 */
function initDocuments() {
  if (!dom.documentSelect || !dom.documentList) return;

  // Document dropdown
  dom.documentSelect.innerHTML = "";
  for (const doc of model.documents) {
    const opt = document.createElement("option");
    opt.value = doc.id;
    opt.textContent = doc.label;
    dom.documentSelect.appendChild(opt);
  }

  dom.documentSelect.addEventListener("change", () => {
    currentDocumentId = dom.documentSelect.value;
    currentNodeId = null;
    renderDocuments();
    renderCurrentRelationshipView();
    clearNodeDetails();
  });
}

/**
 * Render the document list in the sidebar and mark the active one.
 */
function renderDocuments() {
  if (!dom.documentList) return;

  dom.documentList.innerHTML = "";

  for (const doc of model.documents) {
    const li = document.createElement("li");
    li.className = "document-item";
    li.dataset.documentId = doc.id;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = doc.label;
    btn.className = "document-button";

    if (doc.id === currentDocumentId) {
      li.classList.add("selected");
    }

    btn.addEventListener("click", () => {
      currentDocumentId = doc.id;
      if (dom.documentSelect) {
        dom.documentSelect.value = doc.id;
      }
      currentNodeId = null;
      renderDocuments();
      renderCurrentRelationshipView();
      clearNodeDetails();
    });

    li.appendChild(btn);
    dom.documentList.appendChild(li);
  }
}

/**
 * Initialize relationship list.
 */
function initRelationships() {
  if (!dom.relationshipList) return;
  dom.relationshipList.innerHTML = "";

  for (const rel of model.relationships) {
    const li = document.createElement("li");
    li.className = "relationship-item";
    li.dataset.relName = rel.name;
    li.dataset.hierarchical = String(rel.hierarchical);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "relationship-button";

    const nameSpan = document.createElement("span");
    nameSpan.className = "rel-name";
    nameSpan.textContent = rel.name;

    const countSpan = document.createElement("span");
    countSpan.className = "rel-count";
    countSpan.textContent = ` (${rel.edgeCount})`;

    btn.appendChild(nameSpan);
    btn.appendChild(countSpan);

    btn.addEventListener("click", () => {
      currentRelationshipName = rel.name;
      currentNodeId = null;
      renderRelationships();
      renderCurrentRelationshipView();
      clearNodeDetails();
    });

    li.appendChild(btn);
    dom.relationshipList.appendChild(li);
  }
}

/**
 * Render relationship list with selection state.
 */
function renderRelationships() {
  if (!dom.relationshipList) return;

  const items = dom.relationshipList.querySelectorAll(".relationship-item");
  items.forEach((item) => {
    const name = item.dataset.relName;
    if (name === currentRelationshipName) {
      item.classList.add("selected");
    } else {
      item.classList.remove("selected");
    }
  });

  const rel = model.relationships.find((r) =>
    r.name === currentRelationshipName
  );
  if (!rel) return;

  if (dom.relationshipTitle) {
    dom.relationshipTitle.textContent = rel.name;
  }
  if (dom.relationshipModeHint) {
    dom.relationshipModeHint.textContent = rel.hierarchical
      ? "Hierarchical view (tree)"
      : "Flat view (edge table)";
  }
  if (dom.relationshipMeta) {
    dom.relationshipMeta.textContent = `Edges: ${rel.edgeCount}${
      rel.description ? " – " + rel.description : ""
    }`;
  }
}

/**
 * Based on currentRel and currentDoc, show either the hierarchy view or edge table.
 */
function renderCurrentRelationshipView() {
  const rel = model.relationships.find((r) =>
    r.name === currentRelationshipName
  );
  if (!rel || !currentDocumentId) {
    hideHierarchyView();
    hideEdgeTableView();
    return;
  }

  if (rel.hierarchical) {
    showHierarchyView();
    hideEdgeTableView();
    renderHierarchy(rel.name, currentDocumentId);
  } else {
    hideHierarchyView();
    showEdgeTableView();
    renderEdgeTable(rel.name, currentDocumentId);
  }
}

/**
 * Show/hide helpers.
 */
function showHierarchyView() {
  if (dom.hierarchyView) {
    dom.hierarchyView.style.display = "";
  }
}
function hideHierarchyView() {
  if (dom.hierarchyView) {
    dom.hierarchyView.style.display = "none";
  }
}
function showEdgeTableView() {
  if (dom.edgeTableView) {
    dom.edgeTableView.style.display = "";
  }
}
function hideEdgeTableView() {
  if (dom.edgeTableView) {
    dom.edgeTableView.style.display = "none";
  }
}

/**
 * Render hierarchical tree for a relationship and document.
 */
function renderHierarchy(relName, documentId) {
  if (!dom.hierarchyRoot) return;

  dom.hierarchyRoot.innerHTML = "";

  const relHier = (model.hierarchies && model.hierarchies[relName]) || null;
  if (!relHier) {
    dom.hierarchyRoot.textContent = "No hierarchy data for this relationship.";
    return;
  }

  const forest = relHier[documentId] || [];
  if (!forest.length) {
    dom.hierarchyRoot.textContent =
      "No nodes in this document for this relationship.";
    return;
  }

  const ulRoot = document.createElement("ul");
  ulRoot.className = "tree-root";

  forest.forEach((node) => {
    const li = renderHierarchyNode(node);
    ulRoot.appendChild(li);
  });

  dom.hierarchyRoot.appendChild(ulRoot);
}

/**
 * Recursive render of HierarchyNode to <li>.
 */
function renderHierarchyNode(hNode) {
  const li = document.createElement("li");
  li.className = "tree-node";
  li.dataset.nodeId = hNode.nodeId;

  const node = model.nodes[hNode.nodeId];
  const labelText = node ? node.label : hNode.nodeId;

  const headerDiv = document.createElement("div");
  headerDiv.className = "tree-node-header";

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "tree-node-toggle";
  toggleBtn.setAttribute("aria-expanded", "true");
  toggleBtn.textContent = "▾";

  const labelBtn = document.createElement("button");
  labelBtn.type = "button";
  labelBtn.className = "tree-node-label";
  labelBtn.textContent = labelText;

  labelBtn.addEventListener("click", () => {
    selectNode(hNode.nodeId);
  });

  toggleBtn.addEventListener("click", () => {
    const childrenUl = li.querySelector(".tree-children");
    if (!childrenUl) return;
    const expanded = toggleBtn.getAttribute("aria-expanded") === "true";
    toggleBtn.setAttribute("aria-expanded", String(!expanded));
    toggleBtn.textContent = expanded ? "▸" : "▾";
    childrenUl.style.display = expanded ? "none" : "";
  });

  headerDiv.appendChild(toggleBtn);
  headerDiv.appendChild(labelBtn);

  const badgesSpan = document.createElement("span");
  badgesSpan.className = "tree-node-badges";
  const nodeRels = node && Array.isArray(node.rels) ? node.rels : [];
  if (nodeRels.length) {
    badgesSpan.textContent = nodeRels.join(", ");
  }
  headerDiv.appendChild(badgesSpan);

  li.appendChild(headerDiv);

  if (hNode.children && hNode.children.length > 0) {
    const ulChildren = document.createElement("ul");
    ulChildren.className = "tree-children";
    hNode.children.forEach((child) => {
      const childLi = renderHierarchyNode(child);
      ulChildren.appendChild(childLi);
    });
    li.appendChild(ulChildren);
  }

  return li;
}

/**
 * Render edge table for a relationship and document.
 */
function renderEdgeTable(relName, documentId) {
  if (!dom.edgeTableBody) return;

  dom.edgeTableBody.innerHTML = "";

  const relEdges = (model.edges && model.edges[relName]) || [];
  const edgesForDoc = relEdges.filter((e) => e.documentId === documentId);

  if (!edgesForDoc.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.textContent = "No edges for this document and relationship.";
    tr.appendChild(td);
    dom.edgeTableBody.appendChild(tr);
    return;
  }

  edgesForDoc.forEach((edge) => {
    const fromNode = model.nodes[edge.from];
    const toNode = model.nodes[edge.to];

    const tr = document.createElement("tr");
    tr.dataset.edgeId = edge.id;

    const tdFromId = document.createElement("td");
    const fromBtn = document.createElement("button");
    fromBtn.type = "button";
    fromBtn.className = "node-link";
    fromBtn.dataset.nodeId = edge.from;
    fromBtn.textContent = fromNode ? fromNode.id : edge.from;
    fromBtn.addEventListener("click", () => selectNode(edge.from));
    tdFromId.appendChild(fromBtn);

    const tdToId = document.createElement("td");
    const toBtn = document.createElement("button");
    toBtn.type = "button";
    toBtn.className = "node-link";
    toBtn.dataset.nodeId = edge.to;
    toBtn.textContent = toNode ? toNode.id : edge.to;
    toBtn.addEventListener("click", () => selectNode(edge.to));
    tdToId.appendChild(toBtn);

    const tdFromLabel = document.createElement("td");
    tdFromLabel.textContent = fromNode ? fromNode.label : "";

    const tdToLabel = document.createElement("td");
    tdToLabel.textContent = toNode ? toNode.label : "";

    tr.appendChild(tdFromId);
    tr.appendChild(tdToId);
    tr.appendChild(tdFromLabel);
    tr.appendChild(tdToLabel);

    dom.edgeTableBody.appendChild(tr);
  });
}

/**
 * Select a node by id and update right-hand panels.
 */
function selectNode(nodeId) {
  currentNodeId = nodeId;

  // Clear any previous selection highlighting
  document
    .querySelectorAll(".tree-node.selected, .node-link.selected")
    .forEach((el) => el.classList.remove("selected"));

  // Highlight in tree, if present
  const treeNode = document.querySelector(
    `.tree-node[data-node-id="${CSS.escape(nodeId)}"]`,
  );
  if (treeNode) {
    treeNode.classList.add("selected");
  }

  // Highlight in edge table, if present
  document
    .querySelectorAll(`.node-link[data-node-id="${CSS.escape(nodeId)}"]`)
    .forEach((el) => el.classList.add("selected"));

  renderNodeDetails(nodeId);
}

/**
 * Clear node details panel.
 */
function clearNodeDetails() {
  if (dom.nodeType) dom.nodeType.textContent = "";
  if (dom.nodeLabel) dom.nodeLabel.textContent = "";
  if (dom.nodeRelationships) dom.nodeRelationships.textContent = "";
  if (dom.nodePath) dom.nodePath.textContent = "";

  if (dom.nodeMdastJsonCode) dom.nodeMdastJsonCode.textContent = "";
  if (dom.nodeSourceCodeInner) {
    dom.nodeSourceCodeInner.textContent = "";
    dom.nodeSourceCodeInner.className = "language-markdown";
  }
}

/**
 * Render node details, mdast JSON, and source code for a selected node.
 */
function renderNodeDetails(nodeId) {
  const node = model.nodes[nodeId];
  if (!node) {
    clearNodeDetails();
    return;
  }

  if (dom.nodeType) dom.nodeType.textContent = node.type || "";
  if (dom.nodeLabel) dom.nodeLabel.textContent = node.label || "";
  if (dom.nodeRelationships) {
    dom.nodeRelationships.textContent = Array.isArray(node.rels)
      ? node.rels.join(", ")
      : "";
  }
  if (dom.nodePath) dom.nodePath.textContent = node.path || "";

  // mdast JSON
  if (dom.nodeMdastJsonCode) {
    let mdastText = "";
    if (
      typeof node.mdastIndex === "number" &&
      node.mdastIndex >= 0 &&
      Array.isArray(model.mdastStore) &&
      node.mdastIndex < model.mdastStore.length
    ) {
      try {
        mdastText = JSON.stringify(
          model.mdastStore[node.mdastIndex],
          null,
          2,
        );
      } catch {
        mdastText = "(unable to stringify mdast node)";
      }
    }
    dom.nodeMdastJsonCode.textContent = mdastText;
  }

  // Source code / text
  if (dom.nodeSourceCodeInner) {
    const lang = node.language || "markdown";
    dom.nodeSourceCodeInner.textContent = node.source || "";
    dom.nodeSourceCodeInner.className = `language-${lang}`;

    // Optional: run a syntax highlighter if available
    if (window.Prism && typeof window.Prism.highlightElement === "function") {
      window.Prism.highlightElement(dom.nodeSourceCodeInner);
    } else if (
      window.hljs && typeof window.hljs.highlightElement === "function"
    ) {
      window.hljs.highlightElement(dom.nodeSourceCodeInner);
    }
  }
}

/**
 * Wire any global keyboard or misc events if needed.
 */
function wireGlobalEvents() {
  // Example: simple keyboard shortcuts could be added here later.
}

// Run main on DOMContentLoaded
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    main().catch((err) => console.error(err));
  });
} else {
  main().catch((err) => console.error(err));
}
