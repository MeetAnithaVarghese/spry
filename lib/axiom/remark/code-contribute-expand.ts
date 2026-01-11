/**
 * code-contribute-expand.ts
 *
 * A small pre-pass plugin that expands argument-only `contribute` specs into real code blocks.
 *
 * Why this exists:
 * - You can author a compact spec like:
 *
 *   ```contribute expand
 *   sql core-ddl -X prime --include ../../src/core-ddl.sqlite.sql
 *   sql info-schema -X prime --include ../../src/info-schema.sqlite.sql
 *   ```
 *
 * - And have it expanded into equivalent empty code blocks whose behavior is handled by existing plugins:
 *
 *   ```sql core-ddl -X prime --include ../../src/core-ddl.sqlite.sql
 *   ```
 *
 *   ```sql info-schema -X prime --include ../../src/info-schema.sqlite.sql
 *   ```
 *
 * This plugin only performs expansion/injection. It does NOT attach include/extension behaviors.
 * Run it before your existing `prepareExternalContributions()` and `prepareIncludedNodes()` so downstream
 * logic can remain unchanged.
 *
 * Interpolation:
 * - If the contribute fence PI flags contain `--interpolate` or `-I`, the spec body is interpolated
 *   before parsing lines.
 *
 * REMARKS directive:
 * - Inside the spec body, a line starting with `REMARKS` sets a default body for subsequent expanded cells:
 *
 *     REMARKS select 1 as placeholder;
 *     sql a --include ./a.sql
 *     sql b --include ./b.sql
 *
 *   This will expand `sql a ...` and `sql b ...` with `value` set to `select 1 as placeholder;`.
 *
 * Comments:
 * - Spec body lines starting with `#`, `//`, or `--` are treated as comments and ignored.
 */
import type { Code, Node, Root } from "types/mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";
import { safeInterpolate } from "../../universal/flexible-interpolator.ts";
import { codeFrontmatter } from "../mdast/code-frontmatter.ts";

export interface ContributeExpandOptions {
  /**
   * Which contribute identities trigger expansion.
   * Default: ["expand", "explode"]
   */
  readonly keywords?: readonly string[];

  /**
   * Whether to keep the original spec node after injecting expanded nodes.
   * - true  => keep spec, insert expanded nodes after it
   * - false => replace spec with expanded nodes
   *
   * Default: keep the spec node.
   */
  readonly retainAfterInjections?: (spec: Code) => boolean;

  /**
   * Optional line transform before parsing (return false to skip a line).
   * Useful for custom comment syntaxes, templating, etc.
   */
  readonly transformLine?: (line: string, lineNum: number) => string | false;

  /**
   * Interpolation context provider used when the spec fence has `--interpolate` / `-I`.
   * Values are available to the interpolator in addition to `{ code, contributeFM }`.
   */
  readonly interpolationCtx?: (
    tree: Root,
    file: VFile,
  ) => Record<string, unknown>;

  /**
   * Optional provenance/telemetry hook to capture "edges" created by expansion.
   * Each edge indicates: spec node -> injected code node.
   */
  readonly consumeEdges?: (
    edges: { generatedBy: Node; expanded: Node }[],
    vfile: VFile,
    tree: Root,
  ) => void;
}

function isContributeFence(code: Code) {
  return code.lang === "contribute";
}

function hasInterpolateFlag(fm: ReturnType<typeof codeFrontmatter>) {
  if (!fm) return false;
  const flags = fm.pi?.flags ?? {};
  return flags["interpolate"] === true || flags["I"] === true;
}

type ParsedExpandLine = Readonly<{
  kind: "emit";
  lang: string;
  meta?: string;
  lineNum: number;
  body?: string;
}>;

function parseExpandLines(
  src: string,
  opts?: Pick<ContributeExpandOptions, "transformLine">,
) {
  const out: ParsedExpandLine[] = [];
  const lines = src.split(/\r?\n/);

  const isComment = (s: string) =>
    s.startsWith("#") || s.startsWith("//") || s.startsWith("--");

  let remarksBody: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;

    let raw = (lines[i] ?? "").trim();
    if (!raw) continue;

    if (isComment(raw)) continue;

    if (opts?.transformLine) {
      const transformed = opts.transformLine(raw, lineNum);
      if (transformed === false) continue;
      raw = transformed.trim();
      if (!raw) continue;
      if (isComment(raw)) continue;
    }

    // REMARKS <text...> sets the default body for subsequent expanded cells.
    if (raw.startsWith("REMARKS")) {
      const rest = raw.slice("REMARKS".length).trim();
      remarksBody = rest.length ? rest : "";
      continue;
    }

    // token 0 => code.lang, remainder => code.meta (verbatim)
    const m = /^(\S+)(?:\s+(.*))?$/.exec(raw);
    if (!m) continue;

    const lang = m[1];
    const meta = m[2]?.trim();

    out.push({
      kind: "emit",
      lang,
      meta: meta || undefined,
      lineNum,
      body: remarksBody,
    });
  }

  return out;
}

export const contributeExpand: Plugin<[ContributeExpandOptions?], Root> = (
  options,
) => {
  const keywords = options?.keywords ?? ["expand", "explode"];
  const retainAfterInjections = options?.retainAfterInjections ?? (() => true);

  return (tree: Root, vfile: VFile) => {
    const mutations: {
      // deno-lint-ignore no-explicit-any
      parent: any;
      index: number;
      injected: Node[];
      mode: "retain-after-injections" | "remove-before-injections";
      generatedBy: Node;
    }[] = [];

    visit(tree, "code", (code: Code, index, parent) => {
      if (parent == null || index == null) return;
      if (!isContributeFence(code)) return;

      const fm = codeFrontmatter(code, { cacheableInCodeNodeData: false });
      if (!fm) return;

      const identity = fm.pi.pos[0];
      if (!identity || !keywords.includes(identity)) return;

      let body = code.value ?? "";
      if (hasInterpolateFlag(fm)) {
        const iCtx = options?.interpolationCtx?.(tree, vfile) ?? {};
        body = safeInterpolate(body, { code, contributeFM: fm, ...iCtx });
      }

      const parsed = parseExpandLines(body, {
        transformLine: options?.transformLine,
      });

      const injected: Node[] = [];
      for (const item of parsed) {
        const position = code.position
          ? {
            line: code.position.start.line + item.lineNum,
            column: 1,
            offset: undefined,
          }
          : undefined;

        const n: Code = {
          type: "code",
          lang: item.lang,
          meta: item.meta,
          value: item.body ?? "",
          position: position ? { start: position, end: position } : undefined,
        };

        injected.push(n);
      }

      if (!injected.length) return;

      const mode = retainAfterInjections(code)
        ? "retain-after-injections"
        : "remove-before-injections";

      mutations.push({ parent, index, injected, mode, generatedBy: code });
    });

    // Apply mutations after traversal, right-to-left.
    mutations.sort((a, b) => b.index - a.index);

    // Emit edges (spec -> injected) before mutating so `generatedBy` remains stable.
    if (options?.consumeEdges) {
      const edges: { generatedBy: Node; expanded: Node }[] = [];
      for (const m of mutations) {
        for (const n of m.injected) {
          edges.push({ generatedBy: m.generatedBy, expanded: n });
        }
      }
      if (edges.length) options.consumeEdges(edges, vfile, tree);
    }

    for (const { parent, index, injected, mode } of mutations) {
      if (mode === "remove-before-injections") {
        parent.children.splice(index, 1, ...injected);
      } else {
        parent.children.splice(index + 1, 0, ...injected);
      }
    }

    return tree;
  };
};
