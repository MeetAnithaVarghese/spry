import * as p from "./protocol.ts";

export interface TapContentHtmlOptions<
  Describable extends string,
  Diagnosable extends p.Diagnostics,
> {
  readonly preamble?: (tc: p.TapContent<Describable, Diagnosable>) => string;
  readonly title: (tc: p.TapContent<Describable, Diagnosable>) => string;
  readonly css: (tc: p.TapContent<Describable, Diagnosable>) => string;

  /**
   * Render the diagnostics payload for a single test-case.
   * If you keep the default, it renders a table and supports attr-level overrides.
   */
  readonly diagnosticsHtml: (
    diagnostics: p.Diagnostics,
    tc: p.TapContent<Describable, Diagnosable>,
  ) => string;

  /**
   * Optional per-attribute formatter for diagnostics table cells.
   * If it returns a string, that string is used as the HTML for the VALUE cell.
   * If it returns undefined, the default rendering is used.
   */
  readonly diagnosticsAttrHtml?: (args: {
    key: string;
    value: unknown;
    diagnostics: p.Diagnostics;
    tc: p.TapContent<Describable, Diagnosable>;
  }) => string | undefined;

  /**
   * Optional hook to customize the HTML shown in the summary header.
   * If undefined, a default summary (pass/fail counts + plan + filters) is used.
   */
  readonly summaryHtml?: (args: {
    tc: p.TapContent<Describable, Diagnosable>;
    totals: TapHtmlTotals;
  }) => string;

  /**
   * Optional hook to customize how each test summary line is shown.
   * Return undefined to use the default.
   */
  readonly testSummaryHtml?: (args: {
    test: p.TestCase<string, p.Diagnostics>;
    depth: number;
    tc: p.TapContent<Describable, Diagnosable>;
  }) => string | undefined;

  /**
   * Optional hook to customize comment rendering.
   * Return undefined to use the default.
   */
  readonly commentHtml?: (args: {
    comment: p.CommentNode;
    depth: number;
    tc: p.TapContent<Describable, Diagnosable>;
  }) => string | undefined;
}

export type TapHtmlTotals = {
  planned?: number;
  total: number;
  ok: number;
  notOk: number;
  skipped: number;
  todo: number;
  bailedOut: number;
  comments: number;
  withDiagnostics: number;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function stringifyToText(tc: p.TapContent<string, p.Diagnostics>): string {
  // Support either legacy stringify(): string or new stringify(): { lines: string[] }.
  const any = p as unknown as {
    stringify: (tc: p.TapContent<string, p.Diagnostics>) =>
      | string
      | { lines: string[] };
  };
  const out = any.stringify(tc);
  if (typeof out === "string") return out;
  if (out && typeof out === "object" && Array.isArray(out.lines)) {
    return out.lines.join("\n");
  }
  return String(out);
}

function computeTotals(
  tc: p.TapContent<string, p.Diagnostics>,
): TapHtmlTotals {
  let total = 0;
  let ok = 0;
  let notOk = 0;
  let skipped = 0;
  let todo = 0;
  let bailedOut = 0;
  let comments = 0;
  let withDiagnostics = 0;

  const walk = (body: Iterable<p.TestSuiteElement<string, p.Diagnostics>>) => {
    for (const el of body) {
      if (el.nature === "comment") {
        comments += 1;
        continue;
      }
      if (el.nature !== "test-case") continue;

      const t = el as p.TestCase<string, p.Diagnostics>;
      total += 1;
      if (t.ok) ok += 1;
      else notOk += 1;

      if (t.directive?.nature === "SKIP") skipped += 1;
      if (t.directive?.nature === "TODO") todo += 1;
      if (t.directive?.nature === "BAIL_OUT") bailedOut += 1;

      if (t.diagnostics) withDiagnostics += 1;

      if (p.isParentTestCase(t) && t.subtests?.body) walk(t.subtests.body);
    }
  };

  walk(tc.body);

  const planned = tc.plan?.end;
  return {
    planned,
    total,
    ok,
    notOk,
    skipped,
    todo,
    bailedOut,
    comments,
    withDiagnostics,
  };
}

export function tapContentDefaultHtmlOptions<
  Describable extends string,
  Diagnosable extends p.Diagnostics,
>(
  init?: Partial<TapContentHtmlOptions<Describable, Diagnosable>>,
): TapContentHtmlOptions<Describable, Diagnosable> {
  const title = (_tc: p.TapContent<Describable, Diagnosable>) =>
    `TAP Test Results`;

  const css = (): string => `
    :root {
      --bg: #0b1020;
      --panel: rgba(255,255,255,0.06);
      --panel2: rgba(255,255,255,0.08);
      --text: rgba(255,255,255,0.92);
      --muted: rgba(255,255,255,0.7);
      --faint: rgba(255,255,255,0.55);
      --ok: #2ecc71;
      --bad: #ff4d6d;
      --warn: #ffcc00;
      --info: #77a7ff;
      --border: rgba(255,255,255,0.12);
      --shadow: rgba(0,0,0,0.35);
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
      --radius: 14px;
    }

    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: var(--sans);
      background: radial-gradient(1200px 800px at 20% 0%, #17244a 0%, transparent 60%),
                  radial-gradient(900px 700px at 90% 20%, #2b134a 0%, transparent 55%),
                  linear-gradient(180deg, var(--bg) 0%, #050814 100%);
      color: var(--text);
    }

    .wrap { max-width: 1100px; margin: 0 auto; padding: 22px; }

    .header {
      position: sticky;
      top: 0;
      z-index: 20;
      backdrop-filter: blur(10px);
      background: linear-gradient(180deg, rgba(11,16,32,0.92) 0%, rgba(11,16,32,0.65) 100%);
      border-bottom: 1px solid var(--border);
    }

    .header-inner {
      max-width: 1100px;
      margin: 0 auto;
      padding: 18px 22px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 14px;
      align-items: center;
    }

    .title {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .title h1 { font-size: 18px; margin: 0; letter-spacing: 0.2px; }
    .title .meta { font-size: 12px; color: var(--muted); display: flex; gap: 10px; flex-wrap: wrap; }

    .badges { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .badge {
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--panel);
      border: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
      display: inline-flex;
      gap: 8px;
      align-items: center;
      white-space: nowrap;
    }
    .badge strong { color: var(--text); font-weight: 700; }
    .badge.ok strong { color: var(--ok); }
    .badge.bad strong { color: var(--bad); }
    .badge.warn strong { color: var(--warn); }
    .badge.info strong { color: var(--info); }

    .controls {
      margin-top: 10px;
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 10px;
      align-items: center;
    }

    .search {
      width: 100%;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.06);
      color: var(--text);
      outline: none;
    }
    .search::placeholder { color: var(--faint); }

    .btn {
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.06);
      color: var(--text);
      cursor: pointer;
      user-select: none;
    }
    .btn:hover { background: rgba(255,255,255,0.1); }

    .toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--muted);
      padding: 8px 10px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.06);
    }
    .toggle input { accent-color: var(--info); }

    .section {
      margin-top: 18px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 18px 60px var(--shadow);
      overflow: hidden;
    }

    details { border-top: 1px solid rgba(255,255,255,0.06); }
    details:first-child { border-top: none; }

    summary {
      list-style: none;
      cursor: pointer;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 12px 14px;
      background: rgba(255,255,255,0.03);
    }
    summary::-webkit-details-marker { display: none; }

    .pill {
      font-family: var(--mono);
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.05);
      color: var(--muted);
      width: fit-content;
      white-space: nowrap;
    }
    .pill.ok { border-color: rgba(46, 204, 113, 0.35); color: rgba(46, 204, 113, 0.95); }
    .pill.bad { border-color: rgba(255, 77, 109, 0.35); color: rgba(255, 77, 109, 0.95); }
    .pill.warn { border-color: rgba(255, 204, 0, 0.35); color: rgba(255, 204, 0, 0.95); }

    .desc {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      color: var(--text);
    }

    .right {
      display: inline-flex;
      gap: 10px;
      align-items: center;
      justify-content: flex-end;
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
      white-space: nowrap;
    }

    .body {
      padding: 12px 14px 14px 14px;
      background: rgba(255,255,255,0.02);
    }

    .directive {
      display: inline-block;
      margin: 6px 0 10px 0;
      padding: 6px 10px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.05);
      color: var(--muted);
      font-size: 12px;
    }

    table { width: 100%; border-collapse: collapse; }
    td, th {
      border-top: 1px solid rgba(255,255,255,0.08);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
      font-size: 12px;
    }
    th { color: var(--muted); font-weight: 600; background: rgba(255,255,255,0.04); }
    td.key {
      width: 220px;
      font-family: var(--mono);
      color: rgba(255,255,255,0.85);
      word-break: break-word;
    }
    td.val { color: rgba(255,255,255,0.88); }

    pre.diag-pre {
      margin: 0;
      padding: 10px 12px;
      white-space: pre-wrap;
      overflow-x: auto;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.10);
      background: rgba(0,0,0,0.35);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.35;
      color: rgba(255,255,255,0.92);
    }
    pre.diag-pre.diag-stdout { border-left: 3px solid rgba(119,167,255,0.75); }
    pre.diag-pre.diag-stderr { border-left: 3px solid rgba(255,77,109,0.9); color: rgba(255,77,109,0.98); }

    .comment {
      padding: 10px 14px;
      border-top: 1px solid rgba(255,255,255,0.06);
      color: var(--muted);
      font-style: italic;
      background: rgba(255,255,255,0.02);
    }
    .comment code { font-family: var(--mono); color: rgba(255,255,255,0.85); }

    footer {
      margin-top: 14px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: rgba(255,255,255,0.04);
      color: var(--muted);
      box-shadow: 0 18px 60px var(--shadow);
    }

    .hidden { display: none !important; }

    .depth-0 summary { padding-left: 14px; }
    .depth-1 summary { padding-left: 28px; }
    .depth-2 summary { padding-left: 42px; }
    .depth-3 summary { padding-left: 56px; }
    .depth-4 summary { padding-left: 70px; }
  `;

  const diagnosticsAttrHtml = (args: {
    key: string;
    value: unknown;
    diagnostics: p.Diagnostics;
    tc: p.TapContent<Describable, Diagnosable>;
  }): string | undefined => {
    // Default behavior: stdout/stderr rendered as <pre>, stderr emphasized.
    if (args.key === "stderr") {
      const text = valueToText(args.value);
      if (text.trim().length === 0) return "";
      return `<pre class="diag-pre diag-stderr">${escapeHtml(text)}</pre>`;
    }
    if (args.key === "stdout") {
      const text = valueToText(args.value);
      if (text.trim().length === 0) return "";
      return `<pre class="diag-pre diag-stdout">${escapeHtml(text)}</pre>`;
    }
    return undefined;
  };

  const diagnosticsHtml = (
    diagnostics: p.Diagnostics,
    tc: p.TapContent<Describable, Diagnosable>,
  ): string => {
    const attrFmt = init?.diagnosticsAttrHtml ?? diagnosticsAttrHtml;

    let tableHtml =
      `<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>`;
    for (const [key, value] of Object.entries(diagnostics)) {
      const custom = attrFmt?.({ key, value, diagnostics, tc });

      const defaultCell = (() => {
        const text = valueToText(value);
        // If it looks like multi-line content, show it as pre by default (unless overridden).
        if (text.includes("\n") && text.trim().length) {
          return `<pre class="diag-pre">${escapeHtml(text)}</pre>`;
        }
        return escapeHtml(text);
      })();

      const valueCell = custom ?? defaultCell;
      tableHtml += `<tr><td class="key">${
        escapeHtml(key)
      }</td><td class="val">${valueCell}</td></tr>`;
    }
    tableHtml += `</tbody></table>`;
    return tableHtml;
  };

  const summaryHtml = (args: {
    tc: p.TapContent<Describable, Diagnosable>;
    totals: TapHtmlTotals;
  }) => {
    const { totals } = args;
    const planned = totals.planned != null ? String(totals.planned) : "n/a";
    const delta = totals.planned != null ? (totals.total - totals.planned) : 0;
    const deltaText = totals.planned != null && delta !== 0
      ? ` (delta ${delta > 0 ? "+" : ""}${delta})`
      : "";

    return `
      <div class="title">
        <h1>${escapeHtml(init?.title?.(args.tc) ?? title(args.tc))}</h1>
        <div class="meta">
          <span>TAP v${
      escapeHtml(String(args.tc.version?.version ?? 14))
    }</span>
          <span>plan ${escapeHtml(planned)}${escapeHtml(deltaText)}</span>
          <span>tests ${escapeHtml(String(totals.total))}</span>
        </div>

        <div class="controls">
          <input id="tapSearch" class="search" placeholder="Search test name or directive or diagnostics key..." />
          <label class="toggle" title="Show only failing tests">
            <input id="onlyFails" type="checkbox" />
            Only failures
          </label>
          <button id="expandAll" class="btn" type="button">Expand all</button>
        </div>
      </div>

      <div class="badges">
        <span class="badge ok"><strong>${
      escapeHtml(String(totals.ok))
    }</strong> passed</span>
        <span class="badge bad"><strong>${
      escapeHtml(String(totals.notOk))
    }</strong> failed</span>
        <span class="badge warn"><strong>${
      escapeHtml(String(totals.skipped))
    }</strong> skipped</span>
        <span class="badge warn"><strong>${
      escapeHtml(String(totals.todo))
    }</strong> todo</span>
        <span class="badge info"><strong>${
      escapeHtml(String(totals.withDiagnostics))
    }</strong> with diagnostics</span>
      </div>
    `;
  };

  const testSummaryHtml = (args: {
    test: p.TestCase<string, p.Diagnostics>;
    depth: number;
    tc: p.TapContent<Describable, Diagnosable>;
  }) => {
    const t = args.test;
    const statusClass = t.ok ? "ok" : "bad";
    const pill = t.ok ? "PASS" : "FAIL";
    const idx = t.index != null ? String(t.index) : "";
    const dir = t.directive?.nature;
    const dirReason = t.directive?.reason ? ` ${t.directive.reason}` : "";
    const dirText = dir ? `${dir}${dirReason}` : "";
    const rightBits: string[] = [];
    if (idx) rightBits.push(`#${idx}`);
    if (dir) rightBits.push(dirText);

    return `
      <summary>
        <span class="pill ${statusClass}">${escapeHtml(pill)}</span>
        <span class="desc">${escapeHtml(t.description)}</span>
        <span class="right">${escapeHtml(rightBits.join("  "))}</span>
      </summary>
    `;
  };

  const commentHtml = (args: {
    comment: p.CommentNode;
    depth: number;
    tc: p.TapContent<Describable, Diagnosable>;
  }) => {
    const text = args.comment.content ?? "";
    return `<div class="comment"><span>Comment:</span> <code>${
      escapeHtml(text)
    }</code></div>`;
  };

  return {
    title,
    css,
    diagnosticsHtml,
    diagnosticsAttrHtml,
    summaryHtml,
    testSummaryHtml,
    commentHtml,
    ...init,
  };
}

export function tapContentHTML<
  Describable extends string,
  Diagnosable extends p.Diagnostics,
>(
  tc: p.TapContent<Describable, Diagnosable>,
  options = tapContentDefaultHtmlOptions<Describable, Diagnosable>(),
) {
  const { title, css, diagnosticsHtml } = options;

  const totals = computeTotals(
    tc as unknown as p.TapContent<string, p.Diagnostics>,
  );

  let html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${
      escapeHtml(title(tc))
    }</title><style>${css(tc)}</style></head><body>`;

  // Header
  html += `<div class="header"><div class="header-inner">${
    options.summaryHtml ? options.summaryHtml({ tc, totals }) : ""
  }</div></div>`;

  html += `<div class="wrap">`;

  // Preamble if provided
  if (options.preamble) {
    html += options.preamble(tc);
  }

  // Main section
  html += `<div class="section" id="tapRoot">`;
  html += processTestElements(tc.body, 0);
  html += `</div>`;

  // Footers
  for (const footer of tc.footers) {
    html += `<footer>${escapeHtml(footer.content)}</footer>`;
  }

  // Attach script for filtering and expand/collapse
  html += `<script>
    (function () {
      const root = document.getElementById("tapRoot");
      const search = document.getElementById("tapSearch");
      const onlyFails = document.getElementById("onlyFails");
      const expandAll = document.getElementById("expandAll");

      function norm(s) {
        return (s || "").toLowerCase();
      }

      function matchNode(details, q) {
        const text = norm(details.getAttribute("data-search") || "");
        return text.includes(q);
      }

      function applyFilters() {
        const q = norm(search && search.value || "");
        const failsOnly = !!(onlyFails && onlyFails.checked);

        const nodes = root ? root.querySelectorAll("details.tap-test") : [];
        nodes.forEach(function (d) {
          const ok = d.getAttribute("data-ok") === "true";
          const showByFail = !failsOnly || !ok;
          const showByText = !q || matchNode(d, q);
          d.classList.toggle("hidden", !(showByFail && showByText));
        });

        const comments = root ? root.querySelectorAll(".tap-comment") : [];
        comments.forEach(function (c) {
          if (!q && !failsOnly) {
            c.classList.remove("hidden");
            return;
          }
          const t = norm(c.getAttribute("data-search") || "");
          c.classList.toggle("hidden", !(t.includes(q) && !failsOnly));
        });
      }

      function setAll(open) {
        const nodes = root ? root.querySelectorAll("details.tap-test") : [];
        nodes.forEach(function (d) { d.open = open; });
        if (expandAll) expandAll.textContent = open ? "Collapse all" : "Expand all";
      }

      if (search) search.addEventListener("input", applyFilters);
      if (onlyFails) onlyFails.addEventListener("change", applyFilters);
      if (expandAll) {
        expandAll.addEventListener("click", function () {
          const anyClosed = !!(root && root.querySelector("details.tap-test:not([open])"));
          setAll(anyClosed);
        });
      }

      applyFilters();
    })();
  </script>`;

  html += `</div></body></html>`;
  return html;

  function processTestElements(
    body: Iterable<p.TestSuiteElement<string, p.Diagnostics>>,
    depth: number,
  ): string {
    let contentHtml = "";

    for (const element of body) {
      if (element.nature === "test-case") {
        const test = element as p.TestCase<string, p.Diagnostics>;
        const ok = !!test.ok;

        const dirNature = test.directive?.nature ?? "";
        const dirReason = test.directive?.reason ?? "";

        // Build a search blob that includes description, directive, and diag keys
        const diagKeys = test.diagnostics
          ? Object.keys(test.diagnostics).join(" ")
          : "";
        const searchBlob = [
          test.description ?? "",
          dirNature,
          dirReason,
          diagKeys,
        ].join(" ").toLowerCase();

        const summary = options.testSummaryHtml?.({ test, depth, tc }) ??
          "";

        contentHtml +=
          `<details class="tap-test depth-${depth}" data-ok="${ok}" data-search="${
            escapeHtml(searchBlob)
          }">`;

        // Summary line
        contentHtml += summary || (() => {
          const pill = ok ? "PASS" : "FAIL";
          const pillClass = ok ? "ok" : "bad";
          const idx = test.index != null ? `#${test.index}` : "";
          const right = [
            idx,
            dirNature ? `${dirNature} ${dirReason}`.trim() : "",
          ].filter(Boolean).join("  ");
          return `
            <summary>
              <span class="pill ${pillClass}">${escapeHtml(pill)}</span>
              <span class="desc">${escapeHtml(test.description)}</span>
              <span class="right">${escapeHtml(right)}</span>
            </summary>
          `;
        })();

        contentHtml += `<div class="body">`;

        if (test.directive) {
          contentHtml += `<div class="directive">[${
            escapeHtml(test.directive.nature)
          }] ${escapeHtml(test.directive.reason)}</div>`;
        }

        if (test.diagnostics) {
          contentHtml += `<div>${diagnosticsHtml(test.diagnostics, tc)}</div>`;
        }

        if (p.isParentTestCase(test)) {
          if (test.subtests?.body) {
            contentHtml += processTestElements(test.subtests.body, depth + 1);
          }
        }

        contentHtml += `</div></details>`;
        continue;
      }

      if (element.nature === "comment") {
        const comment = element as p.CommentNode;
        const blob = (comment.content ?? "").toLowerCase();
        const rendered = options.commentHtml?.({ comment, depth, tc }) ??
          `<div class="comment"><span>Comment:</span> <code>${
            escapeHtml(comment.content)
          }</code></div>`;
        contentHtml += `<div class="tap-comment" data-search="${
          escapeHtml(blob)
        }">${rendered}</div>`;
      }
    }

    return contentHtml;
  }
}

export interface TapContentMarkdownOptions<
  Describable extends string,
  Diagnosable extends p.Diagnostics,
> {
  readonly preamble?: (tc: p.TapContent<Describable, Diagnosable>) => string;
  readonly diagnosticsMarkdown: (diagnostics: p.Diagnostics) => string;
}

export function tapContentDefaultMarkdownOptions<
  Describable extends string,
  Diagnosable extends p.Diagnostics,
>(
  init?: Partial<TapContentMarkdownOptions<Describable, Diagnosable>>,
): TapContentMarkdownOptions<Describable, Diagnosable> {
  const diagnosticsMarkdown = (diagnostics: p.Diagnostics) => {
    return Object.entries(diagnostics)
      .map(([key, value]) =>
        `- ${key}: ${
          typeof value === "object" ? JSON.stringify(value, null, 2) : value
        }`
      )
      .join("\n");
  };

  return { diagnosticsMarkdown, ...init };
}

export const looksLikeJson = (s: string): boolean => {
  const t = s.trim();
  if (!t) return false;
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
};

export function tapContentMarkdown<
  Describable extends string,
  Diagnosable extends p.Diagnostics,
>(
  tapContent: p.TapContent<Describable, Diagnosable>,
  options = tapContentDefaultMarkdownOptions<Describable, Diagnosable>(),
) {
  const { preamble } = options;

  const lines: string[] = [];

  const push = (...xs: (string | undefined)[]) => {
    for (const x of xs) if (x != null) lines.push(x);
  };

  const mdEscape = (s: string) =>
    s
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");

  const toText = (v: unknown): string => {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (
      typeof v === "number" || typeof v === "boolean" || typeof v === "bigint"
    ) return String(v);
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  };

  // These render after the table as fenced blocks
  const preAttrs = new Set([
    "stdout",
    "stderr",
    "output",
    "error",
    "stack",
    "trace",
  ]);

  const splitDiagnostics = (d: p.Diagnostics) => {
    const tabular: Array<[string, string]> = [];
    const pre: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(d ?? {})) {
      const txt = toText(v);
      if (preAttrs.has(k)) pre.push([k, txt]);
      else tabular.push([k, txt]);
    }
    return { tabular, pre };
  };

  const renderDirectiveText = (dir: p.Directive) =>
    `${mdEscape(dir.nature)}: ${mdEscape(dir.reason)}`;

  const renderPreBlocks = (pairs: Array<[string, string]>) => {
    for (const [k, v] of pairs) {
      const normalized = v.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const fence = looksLikeJson(normalized) ? "```json" : "```";

      push(
        "",
        `**${mdEscape(k)}**:`,
        "",
        fence,
        normalized,
        "```",
      );
    }
  };

  // Header
  const pre = preamble?.(tapContent);
  if (pre && pre.trim().length) push(pre.trimEnd(), "");
  push("# TAP test report");

  if (tapContent.version) push(`- TAP version: ${tapContent.version.version}`);
  if (tapContent.plan) {
    const plan = tapContent.plan;
    const planLine = plan.skip
      ? `- Plan: ${plan.start}..${plan.end} (SKIP: ${
        mdEscape(plan.skip.reason)
      })`
      : `- Plan: ${plan.start}..${plan.end}`;
    push(planLine);
  }

  push("", "## Results");

  let topIndex = 0;

  function renderBody(
    body: Iterable<p.TestSuiteElement<string, p.Diagnostics>>,
    depth: number,
    parentNum?: string,
  ) {
    let localIndex = 0;
    const headingForDepth = (d: number) => Math.min(6, 3 + d);

    for (const element of body) {
      if (element.nature === "comment") {
        const c = element as p.CommentNode;
        push("", `> ${mdEscape(c.content)}`);
        continue;
      }

      if (element.nature !== "test-case") continue;

      const test = element as p.TestCase<string, p.Diagnostics>;

      const idx = parentNum ? ++localIndex : ++topIndex;
      const num = parentNum ? `${parentNum}.${idx}` : `${idx}`;

      const icon = test.ok ? "✅" : "❌";
      const status = test.ok ? "PASS" : "FAIL";

      const h = "#".repeat(headingForDepth(depth));
      push("", `${h} ${icon} ${num} ${mdEscape(test.description)} (${status})`);

      const hasDirective = !!test.directive;
      const hasDiagnostics =
        !!(test.diagnostics && Object.keys(test.diagnostics).length);

      if (hasDirective || hasDiagnostics) {
        push("", "| Attribute | Value |", "|---|---|");
        if (hasDirective) {
          push(`| Directive | ${renderDirectiveText(test.directive!)} |`);
        }
        if (hasDiagnostics) {
          const { tabular, pre } = splitDiagnostics(test.diagnostics!);
          if (tabular.length) {
            // Put tabular diagnostics into the same table
            for (const [k, v] of tabular) {
              push(
                `| ${mdEscape(k)} | ${mdEscape(v).replace(/\n/g, "<br/>")} |`,
              );
            }
          }
          if (pre.length) {
            push(`| Logs | See blocks below |`);
          }
          // Close table, then emit pre blocks
          renderPreBlocks(pre);
        }
      }

      if (p.isParentTestCase(test) && test.subtests) {
        const sub = test.subtests;
        const title = mdEscape(sub.title ?? test.description);

        push("", `<details>`, `<summary>Subtests: ${title}</summary>`);

        if (sub.plan) {
          const sp = sub.plan;
          const spLine = sp.skip
            ? `Plan: ${sp.start}..${sp.end} (SKIP: ${mdEscape(sp.skip.reason)})`
            : `Plan: ${sp.start}..${sp.end}`;
          push("", `> ${spLine}`);
        }

        renderBody(
          sub.body as Iterable<p.TestSuiteElement<string, p.Diagnostics>>,
          depth + 1,
          num,
        );

        push("", `</details>`);
      }
    }
  }

  renderBody(
    tapContent.body as Iterable<p.TestSuiteElement<string, p.Diagnostics>>,
    0,
  );

  const footers = Array.from(tapContent.footers ?? []);
  if (footers.length) {
    push("", "## Notes");
    for (const f of footers) push(`- ${mdEscape(f.content)}`);
  }

  // De-dupe adjacent blank lines and ensure trailing newline
  const out = lines.filter((l, i, a) => !(l === "" && a[i - 1] === ""));
  return out.join("\n") + "\n";
}

export function tapFormat<Canonical extends string, Aliases extends string>(
  identity: Canonical,
  emit: (tc: p.TapContent<string, p.Diagnostics>) => string,
  ...aliases: Aliases[]
) {
  return { identity, aliases, emit };
}

// 4) Fix tapFormats to call tapContentHTML with the widened type (no generic mismatch)
export const tapFormats = [
  tapFormat(
    "canonical",
    (tc) => stringifyToText(tc),
    "--text",
    "--tap",
    ".tap",
  ),
  tapFormat(
    "html",
    (tc) => tapContentHTML<string, p.Diagnostics>(tc),
    "--html",
    "HTML",
    ".html",
  ),
  tapFormat(
    "markdown",
    (tc) => tapContentMarkdown<string, p.Diagnostics>(tc),
    "--md",
    "--markdown",
    ".md",
  ),
  tapFormat(
    "json",
    (tc) => JSON.stringify(tc, null, "  "),
    "--json",
    "--JSON",
    "JSON",
    ".json",
  ),
];

// Compute canonical identities once, as a literal tuple
export const tapStyles = tapFormats.map((f) =>
  f.identity
) as unknown as readonly [
  (typeof tapFormats)[number]["identity"],
  ...Array<(typeof tapFormats)[number]["identity"]>,
];

export type TapStyle = (typeof tapStyles)[number];
export type TapFormat =
  | TapStyle
  | (typeof tapFormats)[number]["aliases"][number];

export function emittableTapContent<
  Describable extends string,
  Diagnosable extends p.Diagnostics,
>(
  tc: p.TapContent<Describable, Diagnosable>,
  format?: TapFormat | undefined,
  options?: {
    readonly defaultFmt?: ReturnType<typeof tapFormat>["emit"];
    readonly onUnknownFormat?: (
      format: TapFormat,
      tc: p.TapContent<Describable, Diagnosable>,
    ) => string | undefined;
  },
) {
  const {
    defaultFmt =
      ((x: p.TapContent<string, p.Diagnostics>) => stringifyToText(x)),
    onUnknownFormat = ((fmt: TapFormat) => `Unknown format '${fmt}'.`),
  } = options ?? {};

  if (!format) return defaultFmt(tc);

  for (const f of tapFormats) {
    if (f.identity === format || f.aliases.find((a) => a === format)) {
      return f.emit(tc);
    }
  }
  return onUnknownFormat(format, tc);
}
