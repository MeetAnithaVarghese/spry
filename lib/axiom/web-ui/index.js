// index.js
// Browser UI for Spry Graph Viewer

import { toMarkdown } from "https://esm.sh/mdast-util-to-markdown@2?bundle";

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

// Node details tabs
let selectedNodeTab = "properties"; // "properties" | "content"

// Spry Content: if true, always show full document regardless of node
let spryContentShowFull = false;

const dom = {};

// Small helper so we never forget to call highlight.js
function highlightCodeBlock(codeEl) {
  if (!codeEl) return;
  if (window.hljs && typeof window.hljs.highlightElement === "function") {
    codeEl.removeAttribute("data-highlighted");
    codeEl.classList.remove("hljs");
    window.hljs.highlightElement(codeEl);
  }
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  if (window.hljs && typeof window.hljs.configure === "function") {
    window.hljs.configure({
      languages: [
        "json",
        "yaml",
        "yml",
        "markdown",
        "typescript",
        "javascript",
      ],
    });
  }

  model = await loadModel();

  initDom();
  wireGlobalEvents();
  populateFooter();

  selectNodeTab("properties");

  // Node type counts (for filter chips)
  const typeCounts = new Map();
  Object.values(model.nodes).forEach((n) => {
    const t = n.type || "unknown";
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
  });
  renderNodeTypeFilter(typeCounts);

  renderDocuments();
  renderRelationships();

  if (model.documents.length) {
    selectDocument(model.documents[0].id);
  }
  if (model.relationships.length) {
    selectRelationship(model.relationships[0].name);
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

  dom.nodeTabs = document.getElementById("node-tabs");
  dom.nodePropertiesPane = document.getElementById("node-properties-pane");
  dom.spryContentPane = document.getElementById("spry-content-pane");
  dom.spryContentHtml = document.getElementById("spry-content-html");
  dom.spryContentShowFull = document.getElementById(
    "spry-content-show-full",
  );

  // Document selector
  if (dom.documentSelect) {
    dom.documentSelect.addEventListener("change", (e) => {
      const id = e.target.value;
      selectDocument(id);
      renderDocuments();
      renderCurrentRelationshipView();
      if (selectedNodeTab === "content" && selectedNodeId) {
        renderSpryContent(selectedNodeId);
      }
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

  // Node tabs
  if (dom.nodeTabs) {
    dom.nodeTabs.querySelectorAll(".node-tab-button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        if (!tab) return;
        selectNodeTab(tab);
      });
    });
  }

  // Spry Content "Show entire document" toggle
  if (dom.spryContentShowFull) {
    dom.spryContentShowFull.checked = spryContentShowFull;
    dom.spryContentShowFull.addEventListener("change", (e) => {
      spryContentShowFull = !!e.target.checked;
      if (selectedNodeTab === "content" && selectedNodeId) {
        renderSpryContent(selectedNodeId);
      }
    });
  }
}

function wireGlobalEvents() {
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
    const newWidth = Math.max(240, startCenterWidthPx + delta);

    const layout = document.getElementById("layout-grid");
    if (!layout) return;

    layout.style.setProperty("--center-width", `${newWidth}px`);
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
        if (selectedNodeTab === "content" && selectedNodeId) {
          renderSpryContent(selectedNodeId);
        }
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
      if (selectedNodeTab === "content" && selectedNodeId) {
        renderSpryContent(selectedNodeId);
      }
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
    dom.relationshipMeta.textContent = `${relDef.hierarchical ? "Axiom hierarchical edges (tree)" : "Axiom tabular edges"
      } • Edges: ${relDef.edgeCount}`;
  }

  renderCurrentRelationshipView();
}

function selectNode(nodeId) {
  selectedNodeId = nodeId;
  renderNodeDetails(nodeId);
  highlightSelectedNode(nodeId);
  if (selectedNodeTab === "content") {
    renderSpryContent(nodeId);
  }
}

// Node details tabs

function selectNodeTab(tab) {
  selectedNodeTab = tab;

  if (dom.nodeTabs) {
    dom.nodeTabs.querySelectorAll(".node-tab-button").forEach((btn) => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle("active", isActive);
    });
  }

  if (dom.nodePropertiesPane) {
    dom.nodePropertiesPane.hidden = tab !== "properties";
  }
  if (dom.spryContentPane) {
    dom.spryContentPane.hidden = tab !== "content";
  }

  if (tab === "content" && selectedNodeId) {
    renderSpryContent(selectedNodeId);
  }
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

  if (allowedNodeTypes.size === 0) {
    allowedNodeTypes = new Set(["heading", "code"]);
  }

  types.forEach(([type, count]) => {
    const chip = document.createElement("label");
    chip.className = "node-type-chip";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = type;

    const checked = allowedNodeTypes.size === 0 || allowedNodeTypes.has(type);

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

      if (allowedNodeTypes.size === 0) {
        // empty => "show all"
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

  const filteredByType = allowedNodeTypes.size > 0 &&
    !allowedNodeTypes.has(type);

  const childLis = [];
  if (hNode.children && hNode.children.length > 0) {
    hNode.children.forEach((child) => {
      const childLi = renderHierarchyNode(child);
      if (childLi) childLis.push(childLi);
    });
  }

  if (filteredByType && childLis.length === 0) {
    return null;
  }

  const li = document.createElement("li");
  li.className = "tree-node";
  li.dataset.nodeId = hNode.nodeId;
  li.dataset.level = String(hNode.level);

  const levelClass = `tree-level-${Math.min(hNode.level, 5)}`;
  li.classList.add(levelClass);

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

// Relationship badge class driven by relationship.category if present
function relBadgeClass(relName) {
  const relDef = model.relationships.find((r) => r.name === relName);
  const category = relDef && relDef.category ? relDef.category : "other";
  switch (category) {
    case "structural":
      return "rel-badge-structural";
    case "frontmatter":
      return "rel-badge-frontmatter";
    case "dependency":
      return "rel-badge-dependency";
    case "task":
      return "rel-badge-task";
    case "important":
      return "rel-badge-important";
    case "role":
      return "rel-badge-role";
    default:
      return "rel-badge-other";
  }
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
  if (dom.nodeRels) {
    dom.nodeRels.textContent = (node.rels || []).join(", ");
  }
  if (dom.nodePath) dom.nodePath.textContent = node.path || "";

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

  if (dom.nodeSourceCode) {
    let langClass = "language-plaintext";
    let source = node.source || "";

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

    const headerEl = document.getElementById("node-code-header");
    if (headerEl) {
      if (mdNode && mdNode.type === "code") {
        const safeLang = lang || "";
        const safeMeta = meta || "";
        headerEl.innerHTML = `<span class="code-header">\`\`\`` +
          `<span class="lang">${safeLang}</span>` +
          (safeMeta ? ` <span class="meta">${safeMeta}</span>` : "") +
          `</span>`;
      } else {
        headerEl.textContent = "";
      }
    }

    dom.nodeSourceCode.className = langClass;
    dom.nodeSourceCode.textContent = source;
    highlightCodeBlock(dom.nodeSourceCode);
  }
}

function highlightSelectedNode(nodeId) {
  document.querySelectorAll(".tree-node.selected").forEach((el) =>
    el.classList.remove("selected")
  );
  const treeNode = document.querySelector(
    `.tree-node[data-node-id="${nodeId}"]`,
  );
  if (treeNode) treeNode.classList.add("selected");

  document.querySelectorAll(".node-link.selected").forEach((el) =>
    el.classList.remove("selected")
  );
  document.querySelectorAll(".node-link").forEach((btn) => {
    if (btn.textContent.endsWith(` ${nodeId}`) || btn.textContent === nodeId) {
      btn.classList.add("selected");
    }
  });
}

// -----------------------------------------------------------------------------
// Spry Content helpers (mdast → markdown section / full document)
// -----------------------------------------------------------------------------

function sanitizeMdastForToMarkdown(node) {
  if (!node || typeof node !== "object") return node;

  const result = { ...node };

  if (Array.isArray(result.children)) {
    result.children = result.children
      .filter(
        (child) =>
          child &&
          typeof child.type === "string" &&
          child.type !== "yaml" &&
          child.type !== "toml" &&
          child.type !== "decorator",
      )
      .map((child) => sanitizeMdastForToMarkdown(child));
  }

  return result;
}

function getDocumentRootMdast(docId) {
  const rootEntry = Object.values(model.nodes).find(
    (n) =>
      n.documentId === docId &&
      n.type === "root" &&
      typeof n.mdastIndex === "number",
  );

  if (!rootEntry) return null;
  return model.mdastStore[rootEntry.mdastIndex] || null;
}

function getNodeStartOffset(node) {
  return node &&
    node.position &&
    node.position.start &&
    typeof node.position.start.offset === "number"
    ? node.position.start.offset
    : -1;
}

// Find the exact heading node inside the root tree that matches mdNode
function findHeadingInRoot(root, mdNode) {
  if (!root || !Array.isArray(root.children)) return null;
  const targetOffset = getNodeStartOffset(mdNode);
  const targetDepth = typeof mdNode.depth === "number" ? mdNode.depth : 1;

  for (const child of root.children) {
    if (
      child &&
      child.type === "heading" &&
      typeof child.depth === "number" &&
      child.depth === targetDepth &&
      getNodeStartOffset(child) === targetOffset
    ) {
      return child;
    }
  }
  return null;
}

// For any node, find the closest preceding heading at the top level
function findContainerHeadingForNode(root, mdNode) {
  if (!root || !Array.isArray(root.children)) return null;
  const nodeOffset = getNodeStartOffset(mdNode);
  if (nodeOffset < 0) return null;

  let best = null;
  let bestOffset = -1;

  for (const child of root.children) {
    if (child && child.type === "heading") {
      const off = getNodeStartOffset(child);
      if (off >= 0 && off <= nodeOffset && off >= bestOffset) {
        best = child;
        bestOffset = off;
      }
    }
  }

  return best;
}

// Given a heading that is actually inside `root.children`, return its section
// (heading + all siblings until the next heading of same-or-shallower depth).
function extractSectionForHeading(root, headingInRoot) {
  const children = root.children || [];
  const len = children.length;
  const depth = typeof headingInRoot.depth === "number"
    ? headingInRoot.depth
    : 1;

  let start = -1;
  for (let i = 0; i < len; i++) {
    if (children[i] === headingInRoot) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let endExclusive = len;
  for (let i = start + 1; i < len; i++) {
    const c = children[i];
    if (
      c &&
      c.type === "heading" &&
      typeof c.depth === "number" &&
      c.depth <= depth
    ) {
      endExclusive = i;
      break;
    }
  }

  return children.slice(start, endExclusive);
}

function markdownFromRoot(root) {
  const safeRoot = sanitizeMdastForToMarkdown(root);
  return toMarkdown(safeRoot);
}

function markdownFromSection(root, headingInRoot) {
  const sectionChildren = extractSectionForHeading(root, headingInRoot);
  if (!sectionChildren || !sectionChildren.length) {
    return markdownFromRoot(root);
  }
  const safeRoot = sanitizeMdastForToMarkdown({
    type: "root",
    children: sectionChildren,
  });
  return toMarkdown(safeRoot);
}

// Decide what markdown to show for the selected node, honoring
//   - spryContentShowFull (checkbox)
//   - root node => full doc
//   - heading => section
//   - other nodes => nearest enclosing section
function buildMarkdownForNodePreview(nodeId) {
  const gvNode = model.nodes[nodeId];
  if (!gvNode) return "";

  const root = getDocumentRootMdast(gvNode.documentId);
  if (!root) return "";

  if (spryContentShowFull || gvNode.type === "root") {
    try {
      return markdownFromRoot(root);
    } catch (err) {
      console.error("toMarkdown(root) failed:", err);
      return "";
    }
  }

  let mdNode = null;
  if (typeof gvNode.mdastIndex === "number") {
    mdNode = model.mdastStore[gvNode.mdastIndex];
  }

  if (!mdNode) {
    try {
      return markdownFromRoot(root);
    } catch (_) {
      return "";
    }
  }

  if (mdNode.type === "heading") {
    const hInRoot = findHeadingInRoot(root, mdNode);
    if (hInRoot) {
      try {
        return markdownFromSection(root, hInRoot);
      } catch (err) {
        console.error("toMarkdown(section heading) failed:", err);
      }
    }
  }

  const containerHeading = findContainerHeadingForNode(root, mdNode);
  if (containerHeading) {
    try {
      return markdownFromSection(root, containerHeading);
    } catch (err) {
      console.error("toMarkdown(section container) failed:", err);
    }
  }

  try {
    return markdownFromRoot(root);
  } catch (err) {
    console.error("toMarkdown(root fallback) failed:", err);
    return "";
  }
}

// Render Spry Content using the global remark pipeline defined in index.html
async function renderSpryContent(nodeId) {
  const pane = dom.spryContentHtml;
  if (!pane) return;

  const node = model.nodes[nodeId];
  if (!node) {
    pane.innerHTML = '<p class="spry-content-empty">No node selected.</p>';
    return;
  }

  const markdown = buildMarkdownForNodePreview(nodeId);
  if (!markdown || !markdown.trim().length) {
    pane.innerHTML =
      '<p class="spry-content-empty">No Spry Content preview available for this node yet.</p>';
    return;
  }

  if (typeof window.SpryRenderMarkdown !== "function") {
    pane.textContent = markdown;
    return;
  }

  try {
    pane.innerHTML = '<p class="spry-content-loading">Rendering content…</p>';
    const html = await window.SpryRenderMarkdown(markdown);
    pane.innerHTML = html;

    // Highlight + scroll to first block (the section root)
    const firstBlock =
      pane.querySelector("h1, h2, h3, h4, h5, h6, p, ul, ol") ||
      pane.firstElementChild;
    if (firstBlock) {
      firstBlock.id = "spry-selected-node";
      firstBlock.classList.add(
        "spry-node-selected",
        "spry-section-selected",
      );
      firstBlock.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    }
  } catch (err) {
    console.error("Failed to render Spry Content:", err);
    pane.innerHTML =
      '<p class="spry-content-error">Failed to render markdown.</p>';
  }
}
