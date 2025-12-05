import { Task, TaskExecutionPlan } from "./task.ts";

export enum ExecutionPlanVisualStyle {
  ASCII_TREE = "ascii-tree",
  ASCII_WORKFLOW = "ascii-workflow",
  ASCII_FLOWCHART = "ascii-flowchart",
  MERMAID_JS = "mermaid-js", // if you already added Mermaid earlier
}

/** Common, precomputed view context shared by all visualizers */
export interface ExecutionPlanViewContext {
  readonly nodes: string[];
  readonly edges: { from: string; to: string; missing: boolean }[];
  readonly indegree: Record<string, number>;
  readonly outdegree: Record<string, number>;
  readonly combinedAdj: Record<
    string,
    { from: string; to: string; missing: boolean }[]
  >;
  readonly incoming: Record<
    string,
    { from: string; to: string; missing: boolean }[]
  >;
  readonly layers: readonly string[][];
  readonly unresolved: readonly string[];
}

/** Tree-style DAG (hierarchical) ASCII visualization */
export function renderAsciiTree(ctx: ExecutionPlanViewContext): string {
  const { nodes, indegree, outdegree, combinedAdj, unresolved } = ctx;

  const lines: string[] = [];
  const seenHeader = new Set<string>();

  // 1) Show per-source outgoing edges (definition order)
  for (const src of Object.keys(combinedAdj)) {
    const outs = combinedAdj[src];
    if (!outs.length) continue;

    if (!seenHeader.has(src)) {
      lines.push(src);
      seenHeader.add(src);
    }

    const lastIdx = outs.length - 1;
    outs.forEach((e, i) => {
      const elbow = i === lastIdx ? "└" : "├";
      const arrow = e.missing ? "─x▶" : "─▶";
      const label = e.missing ? ` (missing)` : "";
      lines.push(`  ${elbow}${arrow} ${e.to}${label}`);
    });
  }

  // 2) Isolated nodes (no in or out)
  const isolated = nodes.filter(
    (n) => (indegree[n] ?? 0) === 0 && (outdegree[n] ?? 0) === 0,
  );
  for (const n of isolated) lines.push(n);

  // 3) Missing-only sources (phantoms)
  for (const [phantom, outs] of Object.entries(combinedAdj)) {
    if (nodes.includes(phantom)) continue;
    if (!outs.length) continue;
    lines.push(`${phantom} (missing)`);
    const lastIdx = outs.length - 1;
    outs.forEach((e, i) => {
      const elbow = i === lastIdx ? "└" : "├";
      lines.push(`  ${elbow}─x▶ ${e.to}`);
    });
  }

  // 4) Unresolved (cycles / unmet chains)
  if (unresolved.length) {
    lines.push("", "# Unresolved (cycle or unmet chain):");
    for (const id of unresolved) lines.push(`- ${id}`);
  }

  return lines.join("\n");
}

/** Workflow-style (layered execution order) ASCII visualization */
export function renderAsciiWorkflow(ctx: ExecutionPlanViewContext): string {
  const { nodes, outdegree, incoming, layers, unresolved } = ctx;

  function formatTaskLine(id: string): string {
    const ins = incoming[id] ?? [];
    const insOk = ins.filter((e) => !e.missing).map((e) => e.from);
    const insMiss = ins.filter((e) => e.missing).map((e) => e.from);

    const fanOut = outdegree[id] ?? 0;
    const needs = insOk.length ? insOk.join(", ") : "—";
    const missing = insMiss.length ? insMiss.join(", ") : "";
    const missingPart = insMiss.length ? ` | missing: ${missing}` : "";
    return `- ${id}  (deps: ${needs}${missingPart} | fan-out: ${fanOut})`;
  }

  const L = layers ?? [];
  const lines: string[] = [];

  lines.push(`# Workflow (DAG execution order)`);
  if (!L.length) {
    lines.push("");
    lines.push(`(no layering available; listing in definition order)`);
    for (const n of nodes) lines.push(formatTaskLine(n));
    if (unresolved.length) {
      lines.push("", "# Unresolved (cycle or unmet chain):");
      for (const id of unresolved) lines.push(`- ${id}`);
    }
    return lines.join("\n");
  }

  L.forEach((layer, i) => {
    const phase = i + 1;
    const width = layer.length;
    lines.push("");
    lines.push(`== Phase ${phase}  (parallel: ${width}) ==`);
    for (const id of layer) lines.push(formatTaskLine(id));
  });

  if (unresolved.length) {
    lines.push("", "# Unresolved (cycle or unmet chain):");
    for (const id of unresolved) lines.push(`- ${id}`);
  }

  return lines.join("\n");
}

/**
 * ASCII Flowchart renderer:
 * - Each root becomes a "lane" (row).
 * - Columns are phases (from ctx.layers). Within a column, multiple tasks mean parallel work (joined by '|').
 * - Arrows (->) between columns indicate serial progression across phases.
 */
export function renderAsciiFlowchart(ctx: ExecutionPlanViewContext): string {
  const { nodes, edges, indegree, layers, unresolved } = ctx;

  // Build quick indices
  const roots = nodes.filter((n) => (indegree[n] ?? 0) === 0);
  const layerIndex = new Map<string, number>();
  (layers ?? []).forEach((layer, i) =>
    layer.forEach((n) => layerIndex.set(n, i))
  );

  // Helper: successors confined to a specific phase and via non-missing edges
  const succInPhase = (fromSet: Set<string>, phaseIdx: number): Set<string> => {
    const targetLayer = layers[phaseIdx] ?? [];
    const targetSet = new Set(targetLayer);
    const out = new Set<string>();
    for (const e of edges) {
      if (e.missing) continue;
      if (!fromSet.has(e.from)) continue;
      if (targetSet.has(e.to)) out.add(e.to);
    }
    return out;
  };

  const L = layers ?? [];
  const colCount = L.length || 1;

  // Build per-root rows across phases
  type Row = { root: string; cells: string[] };
  const rows: Row[] = [];

  // If no layers, render a simple one-column table by topo-ish order: roots then others
  if (!L.length) {
    for (const r of roots.length ? roots : nodes) {
      rows.push({ root: r, cells: [r] });
    }
  } else {
    for (const r of roots.length ? roots : nodes) {
      const cells: string[] = [];
      // Start frontier: either the root itself (if it is in phase 0) or nothing,
      // but we still compute successors phase-by-phase.
      let frontier = new Set<string>([r]);

      for (let p = 0; p < colCount; p++) {
        // If we're at the first phase and root itself lives here, include it as part of first cell
        const initialHere = p === (layerIndex.get(r) ?? -1)
          ? new Set<string>([r])
          : new Set<string>();
        const fromSet = frontier.size ? frontier : initialHere;

        const hits = succInPhase(fromSet, p);
        // If the root itself is in this phase, ensure it shows (even if it has no incoming from prior frontier)
        if ((layerIndex.get(r) ?? -1) === p) hits.add(r);

        const cell = hits.size ? [...hits].join(" | ") : "·";
        cells.push(cell);

        // Next frontier is exactly what we just placed
        frontier = hits;
      }
      rows.push({ root: r, cells });
    }
  }

  // Column headers and width calc
  const headers = L.length ? L.map((_layer, i) => `Phase ${i + 1}`) : ["Tasks"];

  const colWidths = headers.map((h) => h.length);
  for (let c = 0; c < headers.length; c++) {
    for (const row of rows) {
      colWidths[c] = Math.max(colWidths[c], (row.cells[c] ?? "").length);
    }
  }

  const pad = (s: string, w: number) =>
    s + " ".repeat(Math.max(0, w - s.length));
  const joinCols = (cells: string[]) =>
    cells.map((s, i) => pad(s, colWidths[i])).join("  ->  ");

  const lines: string[] = [];

  // Title + unresolved warning
  lines.push(
    "# ASCII Flowchart (roots as lanes; '|' means parallel, arrows mean serial)",
  );
  if (unresolved.length) {
    lines.push("");
    lines.push("# Unresolved (cycle or unmet chain):");
    for (const id of unresolved) lines.push(`- ${id}`);
  }

  // Entry points
  lines.push("");
  lines.push("Entry points:");
  if (roots.length) {
    for (const r of roots) lines.push(`- ${r}`);
  } else {
    lines.push("- (none; graph may be cyclic or unlabeled)");
  }

  // Header row
  lines.push("");
  lines.push("Flow by phases:");
  lines.push(joinCols(headers));

  // Separator
  lines.push(joinCols(headers.map((_h, i) => "-".repeat(colWidths[i]))));

  // Each lane (root)
  for (const row of rows) {
    lines.push(joinCols(row.cells));
  }

  return lines.join("\n");
}

/** Main entry: builds context once; exposes primitives and style-based renderers */
export function executionPlanVisuals<T extends Task>(
  plan: TaskExecutionPlan<T>,
) {
  type Edge = { from: string; to: string; missing: boolean };

  // Nodes in stable, definition order
  const nodes = [...plan.ids];

  // Existing edges (dep -> task) in stable order
  const edges: Edge[] = plan.edges.map(([from, to]) => ({
    from,
    to,
    missing: false,
  }));

  // Missing edges (declared but not defined as tasks)
  for (const [to, missList] of Object.entries(plan.missingDeps)) {
    for (const from of missList) edges.push({ from, to, missing: true });
  }

  // Basic degrees (existing edges only)
  const indegree = { ...plan.indegree };
  const outdegree: Record<string, number> = Object.fromEntries(
    nodes.map((n) => [n, 0]),
  );
  for (const [from, _to] of plan.edges) outdegree[from] += 1;

  // Build a combined adjacency (existing first, then missing deps)
  const combinedAdj: Record<string, Edge[]> = {};
  for (const n of nodes) combinedAdj[n] = [];

  for (const [from, to] of plan.edges) {
    combinedAdj[from].push({ from, to, missing: false });
  }
  for (const [to, missList] of Object.entries(plan.missingDeps)) {
    for (const from of missList) {
      if (!(from in combinedAdj)) combinedAdj[from] = [];
      combinedAdj[from].push({ from, to, missing: true });
    }
  }

  // Reverse adjacency to list incoming deps per node (include phantoms)
  const incoming: Record<string, Edge[]> = {};
  for (const n of nodes) incoming[n] = [];
  for (const e of edges) {
    if (!(e.to in incoming)) incoming[e.to] = [];
    incoming[e.to].push(e);
  }
  for (const [to, missList] of Object.entries(plan.missingDeps)) {
    if (!(to in incoming)) incoming[to] = [];
    for (const from of missList) incoming[to].push({ from, to, missing: true });
  }

  // Shared context
  const ctx: ExecutionPlanViewContext = {
    nodes,
    edges,
    indegree,
    outdegree,
    combinedAdj,
    incoming,
    layers: plan.layers ?? [],
    unresolved: plan.unresolved ?? [],
  };

  return {
    // primitives for DAG renderers / other emitters
    nodes,
    edges,
    layers: ctx.layers,
    roots: nodes.filter((n) => (indegree[n] ?? 0) === 0),
    sinks: nodes.filter((n) => (outdegree[n] ?? 0) === 0),
    unresolved: ctx.unresolved,

    // textual visualizations (top-level pure renderers)
    hierarchicalAscii: () => renderAsciiTree(ctx),
    workflowAscii: () => renderAsciiWorkflow(ctx),
    asciiFlowchart: () => renderAsciiFlowchart(ctx),

    // style-based access
    visualText: (style: ExecutionPlanVisualStyle) => {
      switch (style) {
        case ExecutionPlanVisualStyle.ASCII_TREE:
          return renderAsciiTree(ctx);
        case ExecutionPlanVisualStyle.ASCII_WORKFLOW:
          return renderAsciiWorkflow(ctx);
        case ExecutionPlanVisualStyle.ASCII_FLOWCHART:
          return renderAsciiFlowchart(ctx);
        // case ExecutionPlanVisualStyle.MERMAID_JS: return renderMermaidJs(ctx); // if available
        default:
          return renderAsciiTree(ctx);
      }
    },
  };
}
