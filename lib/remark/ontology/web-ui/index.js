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

const dom = {};

// Hierarchical relationship we use to derive content sections
const CONTENT_HIER_REL = "containedInSection";

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

  // default tab
  selectNodeTab("properties");

  // Build node-type counts from all nodes
  const typeCounts = new Map();
  Object.values(model.nodes).forEach((n) => {
    const t = n.type || "unknown";
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
  });
  renderNodeTypeFilter(typeCounts);

  renderDocuments();
  renderRelationships();

  // default selections: first doc + first relationship
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

  // Tabs + panes
  dom.nodeTabs = document.getElementById("node-tabs");
  dom.nodePropertiesPane = document.getElementById("node-properties-pane");
  dom.spryContentPane = document.getElementById("spry-content-pane");
  dom.spryContentHtml = document.getElementById("spry-content-html");

  // Document selector
  if (dom.documentSelect) {
    dom.documentSelect.addEventListener("change", (e) => {
      const id = e.target.value;
      selectDocument(id);
      renderDocuments();
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
  if (selectedNodeTab === "content") {
    renderSpryContent(nodeId);
  }
}

// Node details tabs

function selectNodeTab(tab) {
  selectedNodeTab = tab;

  // Toggle active tab button
  if (dom.nodeTabs) {
    dom.nodeTabs.querySelectorAll(".node-tab-button").forEach((btn) => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle("active", isActive);
    });
  }

  // Toggle panes
  if (dom.nodePropertiesPane) {
    dom.nodePropertiesPane.hidden = tab !== "properties";
  }
  if (dom.spryContentPane) {
    dom.spryContentPane.hidden = tab !== "content";
  }

  // If switching to Spry Content, re-render for current node
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
    a[0].localeCompare(b[0]),
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

    const checked =
      allowedNodeTypes.size === 0 || allowedNodeTypes.has(type);

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
    dom.hierarchyRoot.textContent =
      "No hierarchy data for this relationship.";
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
  const filteredByType =
    allowedNodeTypes.size > 0 && !allowedNodeTypes.has(type);

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

// Relationship badge class driven by server-defined relationship.category
function relBadgeClass(relName) {
  const relDef = model.relationships.find((r) => r.name === relName);
  const category = relDef && relDef.category ? relDef.category : "other";
  return `rel-badge-${category}`;
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
  if (dom.nodeRels)
    dom.nodeRels.textContent = (node.rels || []).join(", ");
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
        // Example visual output: ```yaml title=whatever
        const safeLang = lang || "";
        const safeMeta = meta || "";
        headerEl.innerHTML =
          `<span class="code-header">\`\`\`` +
          `<span class="lang">${safeLang}</span>` +
          (safeMeta
            ? ` <span class="meta">${safeMeta}</span>`
            : "") +
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

// Highlight selected node in tree + table

function highlightSelectedNode(nodeId) {
  // tree selection
  document.querySelectorAll(".tree-node.selected").forEach((el) =>
    el.classList.remove("selected"),
  );
  const treeNode = document.querySelector(
    `.tree-node[data-node-id="${nodeId}"]`,
  );
  if (treeNode) treeNode.classList.add("selected");

  // table selection
  document.querySelectorAll(".node-link.selected").forEach((el) =>
    el.classList.remove("selected"),
  );
  document.querySelectorAll(".node-link").forEach((btn) => {
    if (btn.textContent.endsWith(` ${nodeId}`) || btn.textContent === nodeId) {
      btn.classList.add("selected");
    }
  });
}

// -----------------------------------------------------------------------------
// Spry Content (Markdown → HTML via Remark)
//
// For headings:
//   - show the heading itself
//   - plus all of its children in the containedInSection hierarchy
//   - until the boundary of that subtree (i.e., up to its sibling)
// For other nodes:
//   - show node + its subtree if present
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Spry Content (mdast → markdown via mdast-util-to-markdown → HTML via Remark)
//
// For headings:
//   - find the corresponding hierarchy node (containedInSection tree)
//   - collect all mdast nodes in that subtree (heading + its section content)
//   - wrap them in a synthetic root and run toMarkdown(root)
// For other nodes:
//   - just serialize that single mdast node as a small document
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Spry Content (mdast → markdown via mdast-util-to-markdown → HTML via Remark)
//
// For now we render the *entire document* that the node belongs to,
// using the original mdast root so ordering/formatting exactly matches
// the source markdown. This avoids any duplication or reordering bugs
// from graph-based hierarchies.
// -----------------------------------------------------------------------------

function sanitizeMdastForToMarkdown(node) {
  if (!node || typeof node !== "object") return node;

  // Shallow clone so we don't mutate the stored mdast
  const result = { ...node };

  if (Array.isArray(result.children)) {
    result.children = result.children
      // drop unsupported frontmatter / unknown block nodes
      .filter(
        (child) =>
          child &&
          typeof child.type === "string" &&
          child.type !== "yaml" &&
          child.type !== "toml",
      )
      // recurse one level in case of nested containers
      .map((child) => sanitizeMdastForToMarkdown(child));
  }

  return result;
}

function getDocumentRootMdast(docId) {
  // Find the GraphViewer node that represents the mdast root for this doc
  const rootEntry = Object.values(model.nodes).find(
    (n) => n.documentId === docId && n.type === "root" && typeof n.mdastIndex === "number",
  );

  if (!rootEntry) return null;
  return model.mdastStore[rootEntry.mdastIndex] || null;
}

function buildMarkdownForNodeSubtree(nodeId) {
  const gvNode = model.nodes[nodeId];
  if (!gvNode) return "";

  // Preferred: serialize the document's root mdast node
  const rootMdast = getDocumentRootMdast(gvNode.documentId);
  if (rootMdast) {
    const safeRoot = sanitizeMdastForToMarkdown(rootMdast);
    try {
      return toMarkdown(safeRoot);
    } catch (err) {
      console.error("toMarkdown(rootMdast) failed:", err);
    }
  }

  // Fallback: just this node's mdast node wrapped in a synthetic root
  if (typeof gvNode.mdastIndex === "number") {
    const mdNode = model.mdastStore[gvNode.mdastIndex];
    if (mdNode && mdNode.type !== "yaml" && mdNode.type !== "toml") {
      const safeRoot = sanitizeMdastForToMarkdown({
        type: "root",
        children: [mdNode],
      });
      try {
        return toMarkdown(safeRoot);
      } catch (err) {
        console.error("toMarkdown(single-node) failed:", err);
      }
    }
  }

  return "";
}

async function renderSpryContent(nodeId) {
  const pane = dom.spryContentHtml;
  if (!pane) return;

  const node = model.nodes[nodeId];
  if (!node) {
    pane.innerHTML =
      '<p class="spry-content-empty">No node selected.</p>';
    return;
  }

  const markdown = buildMarkdownForNodeSubtree(nodeId);
  if (!markdown || !markdown.trim().length) {
    pane.innerHTML =
      '<p class="spry-content-empty">No Spry Content preview available for this node yet.</p>';
    return;
  }

  // If Remark pipeline not ready yet, just show raw markdown
  if (typeof window.SpryRenderMarkdown !== "function") {
    pane.textContent = markdown;
    return;
  }

  try {
    pane.innerHTML =
      '<p class="spry-content-loading">Rendering content…</p>';
    const html = await window.SpryRenderMarkdown(markdown);
    pane.innerHTML = html;
  } catch (err) {
    console.error("Failed to render Spry Content:", err);
    pane.innerHTML =
      '<p class="spry-content-error">Failed to render markdown.</p>';
  }
}
