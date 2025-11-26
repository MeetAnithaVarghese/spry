// index.js
// Browser UI for Spry Graph Viewer

let model = null;
let selectedDocumentId = null;
let selectedRelationshipName = null;
let selectedNodeId = null;

// allowedNodeTypes = types to SHOW in the hierarchy view.
// If size === 0, show all. Default: show heading + code.
let allowedNodeTypes = new Set(["heading", "code"]);

// Relationship pills toggle
let showRelationshipPills = false;

// Resizer state
let isResizing = false;
let startX = 0;
let startCenterWidthPx = 0;

const dom = {};

// Small helper so we never forget to call highlight.js
function highlightCodeBlock(codeEl) {
  if (!codeEl) return;
  if (window.hljs && typeof window.hljs.highlightElement === "function") {
    // highlight.js v11+ sets a data-highlighted flag to avoid re-highlighting
    // the same element; we need to clear it when the content changes.
    codeEl.removeAttribute("data-highlighted");
    codeEl.classList.remove("hljs"); // extra safety

    window.hljs.highlightElement(codeEl);
  }
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  // Configure highlight.js if available. At this point the <script> tag
  // in index.html has already run.
  if (window.hljs && typeof window.hljs.configure === "function") {
    window.hljs.configure({
      // Let it auto-detect, but common languages we care about:
      languages: ["json", "yaml", "yml", "markdown", "typescript", "javascript"]
    });
  }

  model = await loadModel();

  initDom();
  wireGlobalEvents();

  populateFooter();

  // Build node-type counts from all nodes
  const typeCounts = new Map();
  Object.values(model.nodes).forEach((n) => {
    const t = n.type || "unknown";
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
  });
  renderNodeTypeFilter(typeCounts);

  renderDocuments();
  renderRelationships();

  // default selections from server, with fallback
  const initialDocId =
    model.defaultDocumentId ||
    (model.documents[0] && model.documents[0].id);

  const initialRelName =
    model.defaultRelationshipName ||
    (model.relationships[0] && model.relationships[0].name);

  if (initialDocId) {
    selectDocument(initialDocId);
  }
  if (initialRelName) {
    selectRelationship(initialRelName);
  }

  renderCurrentRelationshipView();
});

// -----------------------------------------------------------------------------
// Load model
// -----------------------------------------------------------------------------

async function loadModel() {
  const script = document.getElementById("web-ui.model.json");
  if (script && script.textContent && script.textContent.trim().length) {
    try {
      return JSON.parse(script.textContent);
    } catch (err) {
      console.error("Failed to parse injected model JSON:", err);
    }
  }

  // Fallback: try fixture.model.json for local testing
  try {
    const res = await fetch("./fixture.model.json");
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch (err) {
    console.error("Failed to load fixture.model.json:", err);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// DOM + Events
// -----------------------------------------------------------------------------

function initDom() {
  dom.documentSelect = document.getElementById("document-select");
  dom.documentList = document.getElementById("document-list");
  dom.relationshipList = document.getElementById("relationship-list");

  dom.relationshipViewPanel = document.getElementById(
    "relationship-view-panel",
  );
  dom.relationshipTitle = document.getElementById("relationship-title");
  dom.relationshipMeta = document.getElementById("relationship-meta");
  dom.relationshipControls = document.getElementById("relationship-controls");
  dom.nodeTypeFilter = document.getElementById("node-type-filter");
  dom.relPillsToggle = document.getElementById("relationship-pills-toggle");

  dom.hierarchyView = document.getElementById("hierarchy-view");
  dom.hierarchyRoot = document.getElementById("hierarchy-root");

  dom.edgeTableView = document.getElementById("edge-table-view");
  dom.edgeTableBody = document.querySelector("#edge-table tbody");

  dom.centerRightResizer = document.getElementById("center-right-resizer");

  dom.nodeId = document.getElementById("node-id");
  dom.nodeType = document.getElementById("node-type");
  dom.nodeLabel = document.getElementById("node-label");
  dom.nodeRels = document.getElementById("node-rels");
  dom.nodePath = document.getElementById("node-path");

  dom.nodeMdastPre = document.getElementById("node-mdast-json");
  dom.nodeMdastCode = dom.nodeMdastPre
    ? dom.nodeMdastPre.querySelector("code")
    : null;
  dom.nodeSourcePre = document.getElementById("node-source-code");
  dom.nodeSourceCode = dom.nodeSourcePre
    ? dom.nodeSourcePre.querySelector("code")
    : null;

  // Document selector
  if (dom.documentSelect) {
    dom.documentSelect.addEventListener("change", (e) => {
      const id = e.target.value;
      selectDocument(id);
      renderCurrentRelationshipView();
    });
  }

  // Relationship pills toggle
  if (dom.relPillsToggle) {
    dom.relPillsToggle.checked = showRelationshipPills;
    dom.relPillsToggle.addEventListener("change", (e) => {
      showRelationshipPills = e.target.checked;
      renderCurrentRelationshipView();
    });
  }
}

function wireGlobalEvents() {
  // Resizer drag between center and right panels
  if (dom.centerRightResizer) {
    dom.centerRightResizer.addEventListener("mousedown", (e) => {
      isResizing = true;
      startX = e.clientX;

      const layout = document.getElementById("layout-grid");
      const center = dom.relationshipViewPanel;
      if (!layout || !center) return;

      const centerRect = center.getBoundingClientRect();
      startCenterWidthPx = centerRect.width;

      document.body.style.userSelect = "none";
    });
  }

  window.addEventListener("mousemove", (e) => {
    if (!isResizing) return;

    const delta = e.clientX - startX;
    const newWidth = Math.max(240, startCenterWidthPx + delta); // min 240px

    const layout = document.getElementById("layout-grid");
    if (!layout) return;

    layout.style.setProperty("--center-width", newWidth + "px");
  });

  window.addEventListener("mouseup", () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.userSelect = "";
    }
  });
}

// -----------------------------------------------------------------------------
// Footer
// -----------------------------------------------------------------------------

function populateFooter() {
  const yearSpan = document.getElementById("footer-year");
  const versionSpan = document.getElementById("footer-version");
  if (yearSpan) yearSpan.textContent = String(new Date().getFullYear());
  if (versionSpan) versionSpan.textContent = model.appVersion || "0.0.0";
}

// -----------------------------------------------------------------------------
// UI: documents + relationships
// -----------------------------------------------------------------------------

function renderDocuments() {
  // select
  if (dom.documentSelect) {
    dom.documentSelect.innerHTML = "";
    model.documents.forEach((doc) => {
      const opt = document.createElement("option");
      opt.value = doc.id;
      opt.textContent = doc.label;
      dom.documentSelect.appendChild(opt);
    });
    if (selectedDocumentId) {
      dom.documentSelect.value = selectedDocumentId;
    }
  }

  // list
  if (dom.documentList) {
    dom.documentList.innerHTML = "";
    model.documents.forEach((doc) => {
      const li = document.createElement("li");
      li.className = "document-item";
      if (doc.id === selectedDocumentId) li.classList.add("selected");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "document-button";
      btn.textContent = doc.label;

      btn.addEventListener("click", () => {
        selectDocument(doc.id);
        renderDocuments();
        renderCurrentRelationshipView();
      });

      li.appendChild(btn);
      dom.documentList.appendChild(li);
    });
  }
}

function renderRelationships() {
  if (!dom.relationshipList) return;

  dom.relationshipList.innerHTML = "";

  model.relationships.forEach((rel) => {
    const li = document.createElement("li");
    li.className = "relationship-item";
    if (rel.name === selectedRelationshipName) {
      li.classList.add("selected");
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "relationship-button";

    const nameSpan = document.createElement("span");
    nameSpan.className = "rel-name";
    nameSpan.textContent = rel.name;

    const countSpan = document.createElement("span");
    countSpan.className = "rel-count";
    countSpan.textContent = `(${rel.edgeCount})`;

    btn.appendChild(nameSpan);
    btn.appendChild(countSpan);

    btn.addEventListener("click", () => {
      selectRelationship(rel.name);
      renderRelationships();
      renderCurrentRelationshipView();
    });

    li.appendChild(btn);
    dom.relationshipList.appendChild(li);
  });
}

// -----------------------------------------------------------------------------
// Selection helpers
// -----------------------------------------------------------------------------

function selectDocument(docId) {
  selectedDocumentId = docId;
  // Update select dropdown
  if (dom.documentSelect) {
    dom.documentSelect.value = docId;
  }
}

function selectRelationship(relName) {
  selectedRelationshipName = relName;

  const relDef = model.relationships.find((r) => r.name === relName);
  if (!relDef) return;

  if (dom.relationshipTitle) {
    dom.relationshipTitle.textContent = relName;
  }
  if (dom.relationshipMeta) {
    dom.relationshipMeta.textContent = `${relDef.hierarchical ? "Hierarchical view (tree)" : "Edge table view"
      } • Edges: ${relDef.edgeCount}`;
  }

  renderCurrentRelationshipView();
}

function selectNode(nodeId) {
  selectedNodeId = nodeId;
  renderNodeDetails(nodeId);
  highlightSelectedNode(nodeId);
}

// -----------------------------------------------------------------------------
// Node type filter
// -----------------------------------------------------------------------------

function renderNodeTypeFilter(typeCounts) {
  if (!dom.nodeTypeFilter) return;

  dom.nodeTypeFilter.innerHTML = "";

  const label = document.createElement("span");
  label.textContent = "Node types:";
  dom.nodeTypeFilter.appendChild(label);

  const types = Array.from(typeCounts.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  // Ensure default allowed set (heading + code) if it's empty
  if (allowedNodeTypes.size === 0) {
    allowedNodeTypes = new Set(["heading", "code"]);
  }

  types.forEach(([type, count]) => {
    const chip = document.createElement("label");
    chip.className = "node-type-chip";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = type;

    const checked = allowedNodeTypes.size === 0
      ? true
      : allowedNodeTypes.has(type);

    input.checked = checked;
    if (checked) chip.classList.add("selected");

    const text = document.createElement("span");
    text.textContent = `${type} (${count})`;

    chip.appendChild(input);
    chip.appendChild(text);

    input.addEventListener("change", () => {
      if (input.checked) {
        chip.classList.add("selected");
        allowedNodeTypes.add(type);
      } else {
        chip.classList.remove("selected");
        allowedNodeTypes.delete(type);
      }

      // If everything is unchecked, treat as "no filter" (show all)
      if (allowedNodeTypes.size === 0) {
        // keep it empty meaning "all types"
      }

      renderCurrentRelationshipView();
    });

    dom.nodeTypeFilter.appendChild(chip);
  });
}

// -----------------------------------------------------------------------------
// Relationship view dispatch
// -----------------------------------------------------------------------------

function renderCurrentRelationshipView() {
  if (!selectedRelationshipName || !selectedDocumentId) return;

  const relDef = model.relationships.find(
    (r) => r.name === selectedRelationshipName,
  );
  if (!relDef) return;

  const isHier = !!relDef.hierarchical;

  if (dom.hierarchyView) {
    dom.hierarchyView.style.display = isHier ? "" : "none";
  }
  if (dom.edgeTableView) {
    dom.edgeTableView.style.display = isHier ? "none" : "";
  }
  if (dom.relationshipControls) {
    dom.relationshipControls.style.display = isHier ? "" : "none";
  }

  if (isHier) {
    renderHierarchy(selectedRelationshipName, selectedDocumentId);
  } else {
    renderEdgeTable(selectedRelationshipName, selectedDocumentId);
  }
}

// -----------------------------------------------------------------------------
// Hierarchy view
// -----------------------------------------------------------------------------

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

  forest.forEach((hNode) => {
    const li = renderHierarchyNode(hNode);
    if (li) ulRoot.appendChild(li);
  });

  dom.hierarchyRoot.appendChild(ulRoot);
}

function renderHierarchyNode(hNode) {
  const node = model.nodes[hNode.nodeId];

  const type = node ? node.type : "unknown";

  // Determine visibility based on allowedNodeTypes
  const filteredByType = allowedNodeTypes.size > 0 &&
    !allowedNodeTypes.has(type);

  // Build children first so we can drop empty pruned branches
  const childLis = [];
  if (hNode.children && hNode.children.length > 0) {
    hNode.children.forEach((child) => {
      const childLi = renderHierarchyNode(child);
      if (childLi) childLis.push(childLi);
    });
  }

  // If this node is filtered AND has no visible children, skip entirely
  if (filteredByType && childLis.length === 0) {
    return null;
  }

  const li = document.createElement("li");
  li.className = "tree-node";
  li.dataset.nodeId = hNode.nodeId;
  li.dataset.level = String(hNode.level);

  const levelClass = `tree-level-${Math.min(hNode.level, 5)}`;
  li.classList.add(levelClass);

  // Render header only if this node's type is visible
  if (!filteredByType) {
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
    const labelText = node ? node.label : hNode.nodeId;
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

    // Relationship pills (optional)
    if (showRelationshipPills) {
      const badgesSpan = document.createElement("span");
      badgesSpan.className = "tree-node-badges";
      const nodeRels = node && Array.isArray(node.rels) ? node.rels : [];

      nodeRels.slice(0, 4).forEach((rel) => {
        const badge = document.createElement("span");
        badge.className = `rel-badge ${relBadgeClass(rel)}`;
        badge.textContent = rel;
        badgesSpan.appendChild(badge);
      });

      headerDiv.appendChild(badgesSpan);
    }

    li.appendChild(headerDiv);
  }

  if (childLis.length > 0) {
    const ulChildren = document.createElement("ul");
    ulChildren.className = "tree-children";
    childLis.forEach((childLi) => ulChildren.appendChild(childLi));
    li.appendChild(ulChildren);
  }

  return li;
}

function relBadgeClass(rel) {
  if (rel === "containedInSection") return "rel-badge-structural";
  if (rel === "frontmatter") return "rel-badge-frontmatter";
  if (rel === "codeDependsOn") return "rel-badge-dep";
  if (rel === "isTask") return "rel-badge-task";
  if (rel === "isImportant") return "rel-badge-important";
  if (typeof rel === "string" && rel.startsWith("role:")) {
    return "rel-badge-role";
  }
  return "rel-badge-other";
}

// -----------------------------------------------------------------------------
// Edge table view
// -----------------------------------------------------------------------------

function renderEdgeTable(relName, documentId) {
  if (!dom.edgeTableBody) return;

  dom.edgeTableBody.innerHTML = "";

  const edgesForRel = model.edges[relName] || [];
  const rows = edgesForRel.filter((e) => e.documentId === documentId);

  rows.forEach((edge) => {
    const tr = document.createElement("tr");

    const fromNode = model.nodes[edge.from];
    const toNode = model.nodes[edge.to];

    const fromCell = document.createElement("td");
    const toCell = document.createElement("td");

    const fromBtn = document.createElement("button");
    fromBtn.type = "button";
    fromBtn.className = "node-link";
    fromBtn.textContent = buildNodeLabelForTable(fromNode, edge.from);
    fromBtn.addEventListener("click", () => selectNode(edge.from));

    const toBtn = document.createElement("button");
    toBtn.type = "button";
    toBtn.className = "node-link";
    toBtn.textContent = buildNodeLabelForTable(toNode, edge.to);
    toBtn.addEventListener("click", () => selectNode(edge.to));

    fromCell.appendChild(fromBtn);
    toCell.appendChild(toBtn);

    tr.appendChild(fromCell);
    tr.appendChild(toCell);

    dom.edgeTableBody.appendChild(tr);
  });
}

function buildNodeLabelForTable(node, nodeId) {
  const base = node && node.label ? node.label : "(node)";
  return `${base} · ${nodeId}`;
}

// -----------------------------------------------------------------------------
// Node details panel
// -----------------------------------------------------------------------------

function renderNodeDetails(nodeId) {
  const node = model.nodes[nodeId];
  if (!node) return;

  if (dom.nodeId) dom.nodeId.textContent = node.id || "";
  if (dom.nodeType) dom.nodeType.textContent = node.type || "";
  if (dom.nodeLabel) dom.nodeLabel.textContent = node.label || "";
  if (dom.nodeRels) dom.nodeRels.textContent = (node.rels || []).join(", ");
  if (dom.nodePath) dom.nodePath.textContent = node.path || "";

  // mdast JSON
  let mdNode = null;
  if (typeof node.mdastIndex === "number") {
    mdNode = model.mdastStore[node.mdastIndex];
  }

  if (dom.nodeMdastCode) {
    dom.nodeMdastCode.className = "language-json";
    dom.nodeMdastCode.textContent = mdNode
      ? JSON.stringify(mdNode, null, 2)
      : "";
    highlightCodeBlock(dom.nodeMdastCode);
  }

  // source / code with language from mdast code node
  if (dom.nodeSourceCode) {
    let langClass = "language-plaintext";
    let source = node.source || "";

    // Determine language + source text
    let lang = "";
    let meta = "";

    if (mdNode && mdNode.type === "code") {
      lang = (mdNode.lang || "").toString().trim();
      meta = (mdNode.meta || "").toString().trim();

      if (lang) langClass = `language-${lang.toLowerCase()}`;
      if (!source && typeof mdNode.value === "string") {
        source = mdNode.value;
      }
    }

    // Render the header above the code block
    const headerEl = document.getElementById("node-code-header");
    if (headerEl) {
      if (mdNode && mdNode.type === "code") {
        // Example output:
        // ```yaml title=whatever
        headerEl.innerHTML =
          `<span class="code-header">\`\`\`<span class="lang">${lang}</span>` +
          (meta ? ` <span class="meta">${meta}</span>` : "") +
          `</span>`;
      } else {
        headerEl.textContent = "";
      }
    }

    // Update the actual code content
    dom.nodeSourceCode.className = langClass;
    dom.nodeSourceCode.textContent = source;

    // Always re-highlight
    highlightCodeBlock(dom.nodeSourceCode);
  }
}

function highlightSelectedNode(nodeId) {
  // tree selection
  document.querySelectorAll(".tree-node.selected").forEach((el) =>
    el.classList.remove("selected")
  );
  const treeNode = document.querySelector(
    `.tree-node[data-node-id="${nodeId}"]`,
  );
  if (treeNode) treeNode.classList.add("selected");

  // table selection
  document.querySelectorAll(".node-link.selected").forEach((el) =>
    el.classList.remove("selected")
  );
  document.querySelectorAll(".node-link").forEach((btn) => {
    if (btn.textContent.endsWith(` ${nodeId}`) || btn.textContent === nodeId) {
      btn.classList.add("selected");
    }
  });
}
