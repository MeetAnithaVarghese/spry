// path-tree-html.ts
//
// Render one or more DocumentTree objects (from path-tree.ts)
// into a single static HTML page that is fully browseable.

import type {
  ClassificationTreeNode,
  CombinedTreeNode,
  ContentTreeNode,
  DocumentTree,
  SectionTreeNode,
} from "./path-tree.ts";
import type { RootContent } from "types/mdast";

// deno-lint-ignore no-explicit-any
type Any = any;

export interface RenderPathTreeHtmlOptions {
  readonly title?: string;
  readonly appVersion?: string;
  readonly documentLabels?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getDocumentLabel(
  doc: DocumentTree,
  index: number,
  labels?: readonly string[],
): string {
  if (labels && labels[index]) return labels[index];

  const data = (doc.root as Any)?.data ?? {};
  const guess = data.file ??
    data.filePath ??
    data.path ??
    data.source ??
    data.filename ??
    undefined;

  if (typeof guess === "string" && guess.trim()) {
    return String(guess);
  }

  return `Document ${index + 1}`;
}

// best-effort mdast text extractor
function nodeText(n: unknown): string {
  const out: string[] = [];
  const walk = (x: Any) => {
    if (!x) return;
    if (typeof x.value === "string") out.push(x.value);
    if (Array.isArray(x.children)) {
      for (const c of x.children) walk(c);
    }
  };
  walk(n);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

interface SerializedMdastChildSummary {
  type: string;
  valuePreview?: string;
  dataKeys?: string[];
}

interface SerializedMdastNode {
  type: string;
  valuePreview?: string;
  valueFull?: string;
  dataKeys?: string[];
  childCount: number;
  children?: SerializedMdastChildSummary[];
  lang?: string;
  meta?: string;
  // snapshot of node.data for JSON viewer
  data?: Record<string, unknown>;
}

function serializeMdastNode(node: RootContent): SerializedMdastNode {
  const text = nodeText(node);
  const data = (node as Any).data;
  const dataKeys = data && typeof data === "object"
    ? Object.keys(data)
    : undefined;

  // JSON-serializable snapshot of data for viewer
  let dataSnapshot: Record<string, unknown> | undefined;
  if (data && typeof data === "object") {
    dataSnapshot = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      try {
        if (
          v == null ||
          typeof v === "string" ||
          typeof v === "number" ||
          typeof v === "boolean"
        ) {
          dataSnapshot[k] = v;
        } else {
          // best effort deep clone for arrays/objects
          dataSnapshot[k] = JSON.parse(JSON.stringify(v));
        }
      } catch {
        dataSnapshot[k] = "[unserializable]";
      }
    }
  }

  const childrenSrc = Array.isArray((node as Any).children)
    ? ((node as Any).children as RootContent[])
    : [];

  const children: SerializedMdastChildSummary[] = childrenSrc.map((ch) => {
    const t = nodeText(ch);
    const chData = (ch as Any).data;
    const chKeys = chData && typeof chData === "object"
      ? Object.keys(chData)
      : undefined;
    return {
      type: (ch as Any).type ?? "unknown",
      valuePreview: t || undefined,
      dataKeys: chKeys,
    };
  });

  const base: SerializedMdastNode = {
    type: (node as Any).type ?? "unknown",
    valuePreview: text || undefined,
    dataKeys,
    childCount: children.length,
    children: children.length ? children : undefined,
    data: dataSnapshot,
  };

  if ((node as Any).type === "code") {
    const anyNode = node as Any;
    const val = typeof anyNode.value === "string"
      ? (anyNode.value as string)
      : "";
    const lang = typeof anyNode.lang === "string"
      ? (anyNode.lang as string)
      : undefined;
    const meta = typeof anyNode.meta === "string"
      ? (anyNode.meta as string)
      : undefined;

    base.valuePreview = val || base.valuePreview;
    base.valueFull = val || undefined;
    base.lang = lang;
    base.meta = meta;
  }

  return base;
}

interface NodeRenderContext {
  nextId: number;
  mdastNodes: SerializedMdastNode[];
}

function allocNodeId(ctx: NodeRenderContext): string {
  ctx.nextId += 1;
  return `n${ctx.nextId}`;
}

/* -------------------------------------------------------------------------- */
/* Node → HTML                                                                */
/* -------------------------------------------------------------------------- */

// For HTML we want full paragraph text, not the truncated label used in CLI.
function fullContentLabel(node: ContentTreeNode): string {
  const txt = nodeText(node.node);
  if (txt) return txt;
  return node.label || "(content)";
}

function renderContentNode(
  node: ContentTreeNode,
  ctx: NodeRenderContext,
): string {
  const id = allocNodeId(ctx);
  const labelText = fullContentLabel(node);
  const label = escapeHtml(labelText);
  const dataset: string[] = [
    `data-node-id="${id}"`,
    `data-kind="content"`,
    `data-label="${label}"`,
  ];

  if (node.identityText) {
    dataset.push(`data-identity="${escapeHtml(node.identityText)}"`);
  }
  if (node.classText) {
    dataset.push(`data-class="${escapeHtml(node.classText)}"`);
  }

  const type = (node.node as { type?: string }).type;
  if (typeof type === "string") {
    dataset.push(`data-node-type="${escapeHtml(type)}"`);
  }

  // serialize mdast node for the details pane
  const mdIndex = ctx.mdastNodes.length;
  ctx.mdastNodes.push(serializeMdastNode(node.node));
  dataset.push(`data-mdast-index="${mdIndex}"`);

  const attrs = dataset.join(" ");
  const icon = (node.node as Any).type === "code" ? "⚙️" : "📄";

  return `
<div class="tree-node content-node" ${attrs}>
  <span class="tree-icon">${icon}</span>
  <span class="tree-label">${label}</span>
</div>`.trim();
}

function renderSectionNode(
  node: SectionTreeNode,
  ctx: NodeRenderContext,
  docIndex: number,
  isTopLevel: boolean,
): string {
  const id = allocNodeId(ctx);
  const label = escapeHtml(node.label || "(section)");
  const dataset: string[] = [
    `data-node-id="${id}"`,
    `data-kind="section"`,
    `data-label="${label}"`,
    `data-doc-index="${docIndex}"`,
  ];
  if (node.identityText) {
    dataset.push(`data-identity="${escapeHtml(node.identityText)}"`);
  }
  if (node.classText) {
    dataset.push(`data-class="${escapeHtml(node.classText)}"`);
  }

  // if section is backed by a heading, serialize that heading node
  const sectionAny = node.section as unknown as {
    nature?: string;
    heading?: RootContent | null;
  };
  if (sectionAny.nature === "heading" && sectionAny.heading) {
    const mdIndex = ctx.mdastNodes.length;
    ctx.mdastNodes.push(serializeMdastNode(sectionAny.heading));
    dataset.push(`data-mdast-index="${mdIndex}"`);
  }

  const attrs = dataset.join(" ");
  const openAttr = isTopLevel ? " open" : "";
  const rootIdAttr = isTopLevel ? ` id="doc-${docIndex}-root"` : "";

  const childrenHtml = node.children
    .map((child) => renderCombinedNode(child, ctx, docIndex, false))
    .join("\n");

  return `
<details${openAttr} ${attrs}${rootIdAttr} class="tree-node section-node">
  <summary>
    <span class="tree-icon">📁</span>
    <span class="tree-label">${label}</span>
  </summary>
  <div class="tree-children">
    ${childrenHtml}
  </div>
</details>`.trim();
}

function renderClassificationNode(
  node: ClassificationTreeNode,
  ctx: NodeRenderContext,
  docIndex: number,
): string {
  const id = allocNodeId(ctx);
  const label = escapeHtml(node.label || "(classification)");
  const dataset: string[] = [
    `data-node-id="${id}"`,
    `data-kind="classification"`,
    `data-label="${label}"`,
    `data-doc-index="${docIndex}"`,
    `data-namespace="${escapeHtml(node.namespace)}"`,
    `data-path="${escapeHtml(node.path)}"`,
  ];
  if (node.classText) {
    dataset.push(`data-class="${escapeHtml(node.classText)}"`);
  }

  const attrs = dataset.join(" ");
  const childrenHtml = node.children
    .map((child) => renderCombinedNode(child, ctx, docIndex, false))
    .join("\n");

  return `
<details class="tree-node classification-node" ${attrs}>
  <summary>
    <span class="tree-icon">🏷️</span>
    <span class="tree-label">${label}</span>
  </summary>
  <div class="tree-children">
    ${childrenHtml}
  </div>
</details>`.trim();
}

function renderCombinedNode(
  node: CombinedTreeNode,
  ctx: NodeRenderContext,
  docIndex: number,
  isTopLevelSection: boolean,
): string {
  switch (node.kind) {
    case "section":
      return renderSectionNode(node, ctx, docIndex, isTopLevelSection);
    case "classification":
      return renderClassificationNode(node, ctx, docIndex);
    case "content":
      return renderContentNode(node, ctx);
  }
}

/* -------------------------------------------------------------------------- */
/* Public render                                                              */
/* -------------------------------------------------------------------------- */

export function renderPathTreeHtml(
  docs: readonly DocumentTree[],
  options: RenderPathTreeHtmlOptions = {},
): string {
  const {
    title = "Spry Programmable Markdown Ontology",
    appVersion = "",
    documentLabels,
  } = options;

  const ctx: NodeRenderContext = { nextId: 0, mdastNodes: [] };

  // Sidebar documents as list items with doc icons, not Pico buttons
  const sidebarItems = docs.map((doc, i) => {
    const label = escapeHtml(getDocumentLabel(doc, i, documentLabels));
    return `<li class="sidebar-doc-item" data-doc-index="${i}" tabindex="0" role="button">
  <span class="sidebar-doc-icon">📄</span>
  <span class="sidebar-doc-label">${label}</span>
</li>`;
  }).join("\n");

  const treeHtml = docs.map((doc, i) => {
    const docLabel = escapeHtml(getDocumentLabel(doc, i, documentLabels));
    const sectionsHtml = doc.sections
      .map((s) => renderCombinedNode(s, ctx, i, true))
      .join("\n");

    return `
<section class="document-tree">
  <h2 class="doc-heading">${docLabel}</h2>
  ${sectionsHtml}
</section>`.trim();
  }).join("\n");

  const versionText = appVersion ? ` • Version ${escapeHtml(appVersion)}` : "";

  // IMPORTANT: embed raw JSON (no HTML escaping) in application/json script.
  // Only escape closing </script> so it can't break out of the tag.
  const mdastJson = JSON.stringify(ctx.mdastNodes).replace(
    /<\/script/gi,
    "<\\/script",
  );

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link
      rel="stylesheet"
      href="https://unpkg.com/@picocss/pico@latest/css/pico.min.css"
    />
    <style>
      :root {
        font-size: 14px;
      }

      body {
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        font-size: 0.9rem;
      }

      h1 {
        font-size: 1.5rem;
        margin-bottom: 0.4rem;
      }

      h2 {
        font-size: 1.05rem;
        margin-bottom: 0.4rem;
      }

      main.container {
        flex: 1 0 auto;
      }

      footer.container {
        flex-shrink: 0;
        margin-top: 1.5rem;
        font-size: 0.8rem;
      }

      #layout-grid {
        display: grid;
        grid-template-columns:
          minmax(10rem, 0.15fr)
          minmax(0, 0.6fr)
          minmax(14rem, 0.25fr);
        gap: 0.75rem;
        align-items: flex-start;
      }

      /* Sidebar: remove extra left whitespace, custom list styling */
      #sidebar {
        max-height: 75vh;
        overflow: auto;
        padding-inline: 0; /* kill container padding */
      }

      #sidebar .panel-header {
        padding-inline: 0.15rem;
      }

      #sidebar ul {
        list-style: none;
        padding-left: 0;
        margin: 0;
      }

      .sidebar-doc-item {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.20rem 0.35rem;
        border-radius: 0.3rem;
        cursor: pointer;
        font-size: 0.85rem;
      }

      .sidebar-doc-item:focus {
        outline: none;
      }

      .sidebar-doc-item:hover,
      .sidebar-doc-item:focus-visible {
        background-color: rgba(148, 163, 184, 0.25);
      }

      .sidebar-doc-item.selected-doc {
        font-weight: 600;
        background-color: rgba(255, 230, 150, 0.7);
      }

      .sidebar-doc-icon {
        flex: 0 0 1.2rem;
        text-align: center;
      }

      .sidebar-doc-label {
        flex: 1 1 auto;
        word-break: break-word;
      }

      body[data-sidebar-collapsed="true"] #sidebar {
        display: none;
      }
      body[data-sidebar-collapsed="true"] #layout-grid {
        grid-template-columns:
          minmax(0, 0.7fr)
          minmax(14rem, 0.3fr);
      }

      body[data-properties-collapsed="true"] #properties-panel {
        display: none;
      }
      body[data-properties-collapsed="true"] #layout-grid {
        grid-template-columns:
          minmax(10rem, 0.2fr)
          minmax(0, 0.8fr);
      }

      body[data-sidebar-collapsed="true"][data-properties-collapsed="true"]
        #layout-grid {
        grid-template-columns: minmax(0, 1fr);
      }

      #tree-panel {
        max-height: 75vh;
        overflow: auto;
        border-left: 1px solid var(--muted-border-color, #dde0e3);
        border-right: 1px solid var(--muted-border-color, #dde0e3);
        padding-inline: 0.75rem;
      }

      #properties-panel {
        max-height: 75vh;
        overflow: auto;
      }

      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        margin-bottom: 0.3rem;
      }

      .panel-header h2 {
        margin: 0;
      }

      .panel-header button {
        padding-inline: 0.4rem;
        padding-block: 0.1rem;
        font-size: 0.75rem;
      }

      /* tree layout + spacing */

      .document-tree {
        margin: 0.1rem 0 0.4rem 0;
      }

      .document-tree details {
        margin: 0;
        padding: 0;
      }

      .tree-node {
        margin: 0;
      }

      .tree-node + .tree-node {
        margin-top: 0.02rem; /* very tight spacing between siblings */
      }

      .tree-node summary,
      .tree-node.content-node {
        display: flex;
        align-items: flex-start;
        gap: 0.35rem;
        padding: 0.02rem 0;
        margin: 0;
        line-height: 1.15;
        list-style: none;
      }

      /* tighten spacing between an open <details> summary and its children */
      .section-node[open] > summary,
      .classification-node[open] > summary {
        margin-bottom: 0;
        padding-bottom: 0;
      }

      .section-node > .tree-children,
      .classification-node > .tree-children {
        margin-top: 0.03rem;
      }

      .tree-node summary::-webkit-details-marker {
        display: none;
      }

      .tree-icon {
        flex: 0 0 1.2rem;
        display: inline-flex;
        justify-content: center;
        margin-top: 0.10rem;
      }

      .tree-label {
        flex: 1 1 auto;
        word-break: break-word;
      }

      .tree-children {
        margin-left: 1.6rem; /* indent children under parent label */
        padding-top: 0;
      }

      .tree-children > .tree-node:first-child {
        margin-top: 0.02rem;
      }

      .content-node {
        cursor: pointer;
        font-size: 0.9rem;
      }

      .section-node > summary,
      .classification-node > summary {
        font-weight: 600;
        font-size: 0.9rem;
      }

      .classification-node > summary {
        color: #8a4dd0; /* match classification color */
      }

      .selected-node {
        background-color: rgba(255, 230, 150, 0.7);
        border-radius: 0.25rem;
      }

      #node-properties-body {
        font-size: 0.85rem;
      }

      #node-properties-body tr td:first-child {
        font-weight: 600;
        white-space: nowrap;
        padding-right: 0.5rem;
      }

      #node-properties-body tr td:last-child {
        word-break: break-word;
      }

      .doc-heading {
        font-size: 0.95rem;
        font-weight: 600;
        margin-top: 0.2rem;
        margin-bottom: 0.3rem;
      }

      #mdast-node-details {
        margin-top: 0.75rem;
        font-size: 0.8rem;
      }

      #mdast-node-details h3 {
        font-size: 0.85rem;
        margin-top: 0.5rem;
        margin-bottom: 0.25rem;
      }

      #mdast-node-details table {
        margin-bottom: 0.4rem;
      }

      #mdast-node-details td:first-child {
        font-weight: 600;
        white-space: nowrap;
        padding-right: 0.5rem;
      }

      #mdast-node-details pre {
        background: #1118270d;
        padding: 0.5rem;
        border-radius: 0.25rem;
        overflow-x: auto;
        font-size: 0.8rem;
      }

      /* JSON viewer styling */
      .json-viewer {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          "Liberation Mono", "Courier New", monospace;
        font-size: 0.78rem;
        background: #0f172a0d;
        border-radius: 0.25rem;
        padding: 0.45rem;
        overflow-x: auto;
      }

      .json-viewer details > summary {
        cursor: pointer;
        list-style: none;
        font-weight: 600;
        margin-bottom: 0.25rem;
      }

      .json-viewer details > summary::-webkit-details-marker {
        display: none;
      }

      .json-viewer details[open] > summary {
        margin-bottom: 0.25rem;
      }

      .json-viewer summary .disclosure-icon {
        display: inline-block;
        width: 1rem;
      }

      @media (max-width: 960px) {
        #layout-grid {
          display: block;
        }
        #tree-panel,
        #sidebar,
        #properties-panel {
          max-height: none;
          margin-bottom: 1rem;
        }
      }
    </style>
  </head>
  <body data-sidebar-collapsed="false" data-properties-collapsed="false">
    <header class="container">
      <h1>${escapeHtml(title)}</h1>
    </header>

    <main class="container">
      <div class="grid" id="layout-grid">
        <aside id="sidebar">
          <div class="panel-header">
            <h2>Documents</h2>
            <button id="toggle-sidebar" class="secondary outline" type="button" aria-pressed="false" aria-label="Toggle documents panel">Hide</button>
          </div>
          <ul>
            ${sidebarItems || "<li><em>No documents</em></li>"}
          </ul>
        </aside>

        <section id="tree-panel">
          <div class="panel-header">
            <h2>Path Tree</h2>
          </div>
          ${treeHtml || "<p><em>No sections available.</em></p>"}
        </section>

        <section id="properties-panel">
          <div class="panel-header">
            <h2>Node Properties</h2>
            <button id="toggle-properties" class="secondary outline" type="button" aria-pressed="false" aria-label="Toggle node properties panel">Hide</button>
          </div>
          <p id="no-node-selected"><em>Click a node in the Path Tree to explore its properties.</em></p>
          <table role="grid" aria-label="Node properties">
            <tbody id="node-properties-body"></tbody>
          </table>
          <div id="mdast-node-details"></div>
        </section>
      </div>
    </main>

    <footer class="container">
      <small>
        &copy; ${
    new Date().getFullYear()
  } Spry Programmable Markdown${versionText}
      </small>
    </footer>

    <script id="mdast-store" type="application/json">${mdastJson}</script>

    <script type="module">
      const treePanel = document.getElementById("tree-panel");
      const propsBody = document.getElementById("node-properties-body");
      const noNodeSelected = document.getElementById("no-node-selected");
      const mdastDetailsEl = document.getElementById("mdast-node-details");
      let selectedNodeEl = null;

      // load serialized mdast nodes
      const mdastStoreEl = document.getElementById("mdast-store");
      let mdastNodes = [];
      if (mdastStoreEl) {
        try {
          mdastNodes = JSON.parse(mdastStoreEl.textContent || "[]");
        } catch (err) {
          console.error("Failed to parse mdast store", err);
        }
      }

      function prettyKey(k) {
        const s = k.replace(/([A-Z])/g, " $1");
        return s.charAt(0).toUpperCase() + s.slice(1);
      }

      function makeTable(rows) {
        const table = document.createElement("table");
        const tbody = document.createElement("tbody");
        table.appendChild(tbody);
        for (const [k, v] of rows) {
          const tr = document.createElement("tr");
          const ktd = document.createElement("td");
          const vtd = document.createElement("td");
          ktd.textContent = k;
          vtd.textContent = v;
          tr.appendChild(ktd);
          tr.appendChild(vtd);
          tbody.appendChild(tr);
        }
        return table;
      }

      function buildJsonViewer(label, obj) {
        if (obj == null || typeof obj !== "object") return null;
        const wrapper = document.createElement("div");
        wrapper.className = "json-viewer";

        const root = document.createElement("details");
        root.open = true;

        const summary = document.createElement("summary");
        const icon = document.createElement("span");
        icon.className = "disclosure-icon";
        icon.textContent = "▾";
        summary.appendChild(icon);
        summary.append(label);
        root.appendChild(summary);

        const pre = document.createElement("pre");
        const code = document.createElement("code");
        try {
          code.textContent = JSON.stringify(obj, null, 2);
        } catch {
          code.textContent = "[unserializable data]";
        }
        pre.appendChild(code);
        root.appendChild(pre);

        // toggle icon
        root.addEventListener("toggle", () => {
          icon.textContent = root.open ? "▾" : "▸";
        });

        wrapper.appendChild(root);
        return wrapper;
      }

      function renderMdastDetails(index) {
        if (!mdastDetailsEl) return;
        mdastDetailsEl.innerHTML = "";
        const node = mdastNodes[index];
        if (!node) return;

        const mainHeading = document.createElement("h3");
        mainHeading.textContent = "mdast Node";
        mdastDetailsEl.appendChild(mainHeading);

        const mainRows = [
          ["Type", node.type || ""],
          ["Value preview", node.valuePreview || ""],
          ["Data keys", (node.dataKeys || []).join(", ") || ""],
          ["Child count", String(node.childCount ?? 0)],
        ];

        if (node.lang) mainRows.push(["Language", node.lang]);
        if (node.meta) mainRows.push(["Meta", node.meta]);

        mdastDetailsEl.appendChild(makeTable(mainRows));

        if (node.type === "code" && node.valueFull) {
          const codeHeading = document.createElement("h3");
          codeHeading.textContent = "Code";
          mdastDetailsEl.appendChild(codeHeading);

          const pre = document.createElement("pre");
          const code = document.createElement("code");
          code.textContent = node.valueFull;
          pre.appendChild(code);
          mdastDetailsEl.appendChild(pre);
        }

        if (node.children && node.children.length) {
          const childHeading = document.createElement("h3");
          childHeading.textContent = "Children";
          mdastDetailsEl.appendChild(childHeading);

          node.children.forEach((ch, idx) => {
            const childRows = [
              ["#", String(idx)],
              ["Type", ch.type || ""],
              ["Value preview", ch.valuePreview || ""],
              ["Data keys", (ch.dataKeys || []).join(", ") || ""],
            ];
            const childTable = makeTable(childRows);
            childTable.classList.add("mdast-child-table");
            mdastDetailsEl.appendChild(childTable);
          });
        }

        // JSON viewer for node.data
        if (node.data) {
          const dataHeading = document.createElement("h3");
          dataHeading.textContent = "Data (JSON)";
          mdastDetailsEl.appendChild(dataHeading);

          const viewer = buildJsonViewer("data", node.data);
          if (viewer) mdastDetailsEl.appendChild(viewer);
        }
      }

      function renderPropertiesFromElement(nodeEl) {
        const dataset = nodeEl.dataset;
        propsBody.innerHTML = "";
        if (mdastDetailsEl) mdastDetailsEl.innerHTML = "";

        const entries = Object.entries(dataset);
        if (!entries.length) {
          noNodeSelected.innerHTML = "<em>No properties on this node.</em>";
        } else {
          noNodeSelected.textContent = "";
        }

        for (const [key, value] of entries) {
          if (key === "nodeId" || key === "mdastIndex") continue;
          const tr = document.createElement("tr");
          const keyTd = document.createElement("td");
          const valTd = document.createElement("td");
          keyTd.textContent = prettyKey(key);
          valTd.textContent = String(value);
          tr.appendChild(keyTd);
          tr.appendChild(valTd);
          propsBody.appendChild(tr);
        }

        // extra inspector-style metadata derived from DOM
        const derivedRows = [];

        // DOM tag name
        derivedRows.push(["DOM tag", nodeEl.tagName.toLowerCase()]);

        // tree depth: number of ancestor .tree-node containers
        let depth = 0;
        let parent = nodeEl.parentElement;
        while (parent && parent !== treePanel) {
          if (parent.classList.contains("tree-node")) depth += 1;
          parent = parent.parentElement;
        }
        derivedRows.push(["Tree depth", String(depth)]);

        // direct children and total descendants
        const childrenContainer = nodeEl.querySelector(":scope > .tree-children");
        let directChildren = 0;
        if (childrenContainer) {
          directChildren = childrenContainer.querySelectorAll(
            ":scope > .tree-node",
          ).length;
        }
        derivedRows.push(["Direct children", String(directChildren)]);

        const totalDesc = nodeEl.querySelectorAll(".tree-node").length - 1;
        derivedRows.push(["Total descendants", String(Math.max(0, totalDesc))]);

        // append derived rows
        for (const [key, value] of derivedRows) {
          const tr = document.createElement("tr");
          const keyTd = document.createElement("td");
          const valTd = document.createElement("td");
          keyTd.textContent = key;
          valTd.textContent = value;
          tr.appendChild(keyTd);
          tr.appendChild(valTd);
          propsBody.appendChild(tr);
        }

        const idxRaw = dataset.mdastIndex;
        if (idxRaw != null && idxRaw !== "") {
          const idx = Number(idxRaw);
          if (!Number.isNaN(idx)) renderMdastDetails(idx);
        }
      }

      treePanel?.addEventListener("click", (ev) => {
        const target = ev.target;
        if (!(target instanceof Element)) return;
        const nodeEl = target.closest("[data-node-id]");
        if (!nodeEl) return;

        if (selectedNodeEl && selectedNodeEl !== nodeEl) {
          selectedNodeEl.classList.remove("selected-node");
        }
        selectedNodeEl = nodeEl;
        selectedNodeEl.classList.add("selected-node");

        renderPropertiesFromElement(nodeEl);
      });

      const sidebarButtons = Array.from(
        document.querySelectorAll(".sidebar-doc-item"),
      );

      function handleSidebarActivate(btn) {
        const idx = btn.getAttribute("data-doc-index");
        if (idx == null) return;

        for (const b of sidebarButtons) {
          b.classList.toggle("selected-doc", b === btn);
        }

        const rootEl = document.getElementById("doc-" + idx + "-root");
        if (rootEl) {
          rootEl.scrollIntoView({ behavior: "smooth", block: "start" });
          rootEl.classList.add("selected-node");
          setTimeout(() => rootEl.classList.remove("selected-node"), 900);
        }
      }

      for (const btn of sidebarButtons) {
        btn.addEventListener("click", () => handleSidebarActivate(btn));
        btn.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            handleSidebarActivate(btn);
          }
        });
      }

      const bodyEl = document.body;
      const sidebarToggle = document.getElementById("toggle-sidebar");
      const propsToggle = document.getElementById("toggle-properties");

      if (sidebarToggle) {
        sidebarToggle.addEventListener("click", () => {
          const collapsed = bodyEl.dataset.sidebarCollapsed === "true";
          const next = (!collapsed).toString();
          bodyEl.dataset.sidebarCollapsed = next;
          sidebarToggle.setAttribute("aria-pressed", next);
          sidebarToggle.textContent = collapsed ? "Hide" : "Show";
        });
      }

      if (propsToggle) {
        propsToggle.addEventListener("click", () => {
          const collapsed = bodyEl.dataset.propertiesCollapsed === "true";
          const next = (!collapsed).toString();
          bodyEl.dataset.propertiesCollapsed = next;
          propsToggle.setAttribute("aria-pressed", next);
          propsToggle.textContent = collapsed ? "Hide" : "Show";
        });
      }
    </script>
  </body>
</html>`;

  return html;
}
