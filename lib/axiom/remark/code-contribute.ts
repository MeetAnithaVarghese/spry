/**
 * code-contribute.ts
 *
 * A small family of Unified/Remark plugins that implement:
 * - spec-driven inclusion (contribute/include/import spec blocks)
 * - inline inclusion (a single code node can self-resolve one or more `--include` flags)
 * - inline extension imports (a single code node can expose `--extension`)
 *
 * The goal is to keep Markdown source readable (short specs) while allowing the processor to:
 * - interpret fenced code blocks as *inclusion specifications* (` ```contribute ` / ` ```include ` / ` ```import `),
 * - optionally interpolate both fence meta and spec body,
 * - resolve local paths / globs (and optionally URLs) into a set of concrete resources,
 * - inject new mdast nodes for each resolved resource,
 * - asynchronously acquire the resource text and replace placeholder values,
 * - allow binary resources to be cataloged but left to the caller for processing,
 * - interpret regular code blocks as *extension specs* (`--extension <specifier>`),
 * - dynamically import extension modules (TypeScript / JavaScript / WASM) via Deno `import(...)`,
 * - make extension entrypoints available to downstream callers without mutating the tree.
 *
 * -----------------------------------------------------------------------------
 * Concepts
 * -----------------------------------------------------------------------------
 *
 * 1) Contribute spec blocks (planning)
 *    A fenced code block whose `lang` (or identity semantics) indicates one of:
 *      - `contribute`
 *      - `include`
 *      - `import`
 *
 *    These blocks contain:
 *      - a *target identity* (positional token after the fence language),
 *      - optional block-level flags (Posix PI flags in code-frontmatter meta),
 *      - a body containing one resource spec per line.
 *
 *    After planning, the original `code` node is upgraded into a `ContributeSpec` by attaching:
 *      - parsed frontmatter (`contributeFM`)
 *      - parsed/queryable PI (`contributeQPI`)
 *      - safe parsed flags (`contributeSF`)
 *      - `contributables(opts)` → a lazy factory that returns `resourceContributions(...)`
 *
 * 2) Single-node include (inline include)
 *    Any regular `code` node (not a spec block) may opt into inclusion if `code.meta` contains:
 *      - one or more `--include <path-or-url>` flags
 *
 *    This attaches:
 *      - `includeResources: ResourceProvenance[]` (in appearance order)
 *      - `acquireResources()` which loads all text resources and concatenates them into `code.value`
 *      - `resourcesAcquired` boolean
 *
 * 3) Extension import (inline extension)
 *    Any regular `code` node (including non-spec blocks) may opt into extension behavior if `code.meta` contains:
 *      - `--extension <specifier>`
 *
 *    This attaches `extensionResource` + `importExtension()` so the caller can:
 *      - dynamically import an external module via Deno `import(specifier)`,
 *      - access its default export as an entrypoint (if `default` is a function),
 *      - keep extension execution and side effects under the caller’s control.
 *
 *    Notes:
 *    - Only `--extension` is supported (no shorthand).
 *    - Loading/instantiation is delegated entirely to Deno dynamic import; this module does not
 *      replicate TS/JS/WASM loading logic.
 *
 * 4) Included nodes (expansion)
 *    Each resolved `ResourceContribution` from a spec block can become an injected mdast node (default: `code`)
 *    that carries:
 *      - `include` (the `ResourceContribution`)
 *      - `acquireContent()` (async fetch/load of the text resource)
 *      - `isContentAcquired`
 *
 * -----------------------------------------------------------------------------
 * Flags and parsing
 * -----------------------------------------------------------------------------
 *
 * Block PI flags on spec fences are validated via `contributePiFlagsSchema` and normalized into:
 *
 * - `--base` / `-B`       => `fromBase` (defaults to "." if omitted)
 * - `--dest`              => `destPrefix`
 * - `--labeled`           => enables labeled grammar in spec body
 * - `--interpolate` / `-I`=> interpolate spec body before parsing (also supports shorthand `-I`)
 *
 * Labeled vs unlabeled:
 * - `include` / `import` fences are treated as "include semantics" and default to labeled parsing unless overridden.
 *
 * Interpolation:
 * - `prepareExternalContributions()` may interpolate `code.meta` and/or spec body using an optional
 *   `interpolationCtx(tree, vfile)` provider; interpolated meta is tracked in `interpolatedCodeMeta`.
 *
 * -----------------------------------------------------------------------------
 * Two-phase design (why two plugins)
 * -----------------------------------------------------------------------------
 *
 * The processing model is intentionally split into:
 *
 * Phase 1: **Annotate / Plan** (no tree edits)
 *   - `prepareExternalContributions` traverses the tree and attaches factories, provenance metadata,
 *     directive-candidate markers, and inline behaviors (include/extension).
 *   - It does NOT inject nodes and does NOT fetch external content.
 *   - It does NOT import/execute extensions unless the caller explicitly invokes `importExtension()`.
 *
 * Phase 2: **Inject** (tree edits)
 *   - `prepareIncludedNodes` consumes `ContributeSpec.contributables(...)`, creates generated nodes,
 *     and mutates the mdast tree in a single post-traversal splice pass.
 *   - It attaches `resolveIncludes()` to the original spec node (as `IncludesSpec`) so acquisition can
 *     happen in a later async step.
 *
 * Phase 3: **Acquire / Import** (async; performed by caller)
 *   - The caller (or a later pipeline stage) invokes:
 *       - `ExternalResource.acquireResources()` for inline includes, and/or
 *       - `IncludesSpec.resolveIncludes()` for spec expansions,
 *     to replace placeholder `code.value` with resolved text content.
 *   - For extensions, the caller invokes:
 *       - `Extension.importExtension()` for any node marked with `--extension`,
 *     to dynamically import the module and obtain its entrypoint.
 *
 * This separation keeps traversal deterministic and makes it easy for downstream tooling to decide:
 * - when to fetch/import (build time vs preview time),
 * - whether to keep or remove spec nodes,
 * - how to route/record inclusion edges for provenance,
 * - how and when to execute extension code.
 *
 * -----------------------------------------------------------------------------
 * Public types
 * -----------------------------------------------------------------------------
 *
 * - `ContributeSpec`:
 *   A `Code` node annotated as a contribute/include/import spec with:
 *     - `identity` (target)
 *     - `contributeFM`, `contributeQPI`, `contributeSF`
 *     - `contributables(opts)` → returns `resourceContributions(...)`
 *
 * - `ExternalResource<N>`:
 *   A node that can self-resolve `--include` into its own `value`:
 *     - `includeResource` (provenance)
 *     - `acquireResources()`
 *     - `resourcesAcquired`
 *
 * - `Extension<N>`:
 *   A node that can expose an external executable module via `--extension`:
 *     - `extensionResource` (provenance)
 *     - `importExtension()` (Deno dynamic import)
 *     - `extensionImported`
 *     - `importedExtension` (optional cache)
 *
 * - `IncludesSpec`:
 *   A `Code` spec node after expansion planning:
 *     - `includables` (generated nodes)
 *     - `resolveIncludes()` (acquires content for all includables)
 *
 * - `IncludedNode<N>`:
 *   A generated node tied to a single `ResourceContribution`:
 *     - `include`
 *     - `acquireContent()`
 *     - `isContentAcquired`
 *
 * -----------------------------------------------------------------------------
 * Plugins
 * -----------------------------------------------------------------------------
 *
 * 1) `prepareExternalContributions(options?)`
 *
 * Responsibilities:
 * - Identify spec blocks (`contribute` / `include` / `import`) via `options.isSpecBlock` (defaults to fence lang).
 * - For spec blocks:
 *   - parse code-frontmatter PI (`codeFrontmatter`)
 *   - validate/normalize flags (`queryPosixPI` + `contributePiFlagsSchema`)
 *   - default `--base` to "." if omitted
 *   - optionally interpolate:
 *       - fence meta (via `codeFrontmatter(... transform ...)`)
 *       - spec body (via `safeInterpolate`) when `--interpolate/-I` is set
 *   - attach:
 *       - directive candidate metadata (`CodeDirectiveCandidate` fields)
 *       - `ContributeSpec` fields + `contributables(opts)` factory
 * - For non-spec blocks:
 *   - if `code.meta` includes `--include`, attach `ExternalResource` fields via `externalResource(...)`
 *   - if `code.meta` includes `--extension`, attach `Extension` fields via `extension(...)`
 *
 * Result:
 * - The tree is annotated with "plans" for inclusion and extension imports but remains structurally unchanged.
 *
 * 2) `prepareIncludedNodes(options)`
 *
 * Responsibilities:
 * - Visit `ContributeSpec` nodes and ask `options.isSpecBlock(spec, vfile, root)` whether/how to expand them.
 *   - If it returns `false`, skip.
 *   - If it returns contribute options, they are passed into `spec.contributables(...)`.
 * - For each resolved `ResourceContribution`:
 *   - generate a node via `options.generatedNode` (default `generatedCodeNode`)
 *   - attach `IncludedNode` fields (`include`, `acquireContent`, `isContentAcquired`)
 * - Attach `IncludesSpec` conveniences to the spec node:
 *   - `includables` array
 *   - `resolveIncludes()` that sequentially acquires all includables
 * - Mutate the tree (after traversal) by splicing in generated nodes:
 *   - "retain-after-injections": keep the spec node, insert generated nodes after it
 *   - "remove-before-injections": replace the spec node with generated nodes
 *   (controlled by `options.retainAfterInjections`)
 * - Optionally report graph edges (`options.consumeEdges`) for provenance/telemetry.
 *
 * -----------------------------------------------------------------------------
 * Typical pipeline usage
 * -----------------------------------------------------------------------------
 *
 * 1) Run `prepareExternalContributions()` to annotate spec blocks, inline includes, and extensions.
 * 2) Run `prepareIncludedNodes()` to inject generated nodes for spec blocks.
 * 3) After parsing (async), call:
 *    - `ExternalResource.acquireResources()` for inline `--include` nodes, and/or
 *    - `IncludesSpec.resolveIncludes()` for spec-expanded nodes,
 *    to replace placeholder values with fetched text.
 * 4) When ready to load extensions, call:
 *    - `Extension.importExtension()` for any node with `--extension`,
 *    to obtain the imported module and optional entrypoint.
 */
import { assert } from "@std/assert";
import z from "@zod/zod";
import type { Code, Node, Root } from "types/mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";
import { safeInterpolate } from "../../universal/flexible-interpolator.ts";
import {
  flexibleTextSchema,
  InstructionsResult,
  mergeFlexibleText,
  queryPosixPI,
  rewrittenInstructions,
} from "../../universal/posix-pi.ts";
import {
  ContributeSpecLine,
  ResourceContribution,
  resourceContributions,
} from "../../universal/resource-contributions.ts";
import {
  provenanceFromPath,
  provenanceResource,
  resourceFromPath,
  ResourceProvenance,
} from "../../universal/resource.ts";
import { createRegexRewriter } from "../../universal/text-utils.ts";
import {
  type CodeFrontmatter,
  codeFrontmatter,
} from "../mdast/code-frontmatter.ts";
import { dataBag } from "../mdast/data-bag.ts";
import { addIssue, addIssues, NodeIssue } from "../mdast/node-issues.ts";
import {
  CodeDirectiveCandidate,
  isCodeDirectiveCandidate,
} from "./code-directive-candidates.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export const contributePiFlagsSchema = z.object({
  base: flexibleTextSchema.optional(),
  dest: z.string().optional(),
  labeled: z.boolean().optional(),
  interpolate: z.boolean().optional(),

  // shortcuts
  /* base */ B: flexibleTextSchema.optional(),
  /* interpolate */ I: z.boolean().optional(),
}).transform((raw) => ({
  base: mergeFlexibleText(raw.base, raw.B),
  dest: raw.dest,
  labeled: raw.labeled,
  interpolate: raw.I ?? raw.interpolate,
}));

export type ContributePiFlags = z.infer<typeof contributePiFlagsSchema>;

export type ContributeSpec = Code & {
  identity?: string;
  contributeFM: CodeFrontmatter;
  contributeQPI: ReturnType<typeof queryPosixPI<ContributePiFlags>>;
  contributeSF: ReturnType<
    ReturnType<typeof queryPosixPI<ContributePiFlags>>["safeFlags"]
  >;
  contributables: (opts?: {
    resolveBasePath?: (path: string) => string;
    allowUrls?: boolean;
    /** Default destPrefix for lines that omit it. */
    destPrefix?: string;
    /** Enable labeled grammar in the spec body. */
    labeled?: boolean;
    /** Optional line transform before parsing spec body. */
    transform?: (line: string, lineNum: number) => string | false;
  }) => ReturnType<typeof resourceContributions>;
};

export function isContributeSpec(code: Code): code is ContributeSpec {
  const c = code as unknown as Partial<ContributeSpec>;
  return !!(
    c &&
    typeof c === "object" &&
    typeof c.contributables === "function" &&
    !!c.contributeFM &&
    !!c.contributeQPI &&
    !!c.contributeSF
  );
}

export interface ContributeOptions {
  readonly isSpecBlock?: (node: Code) => boolean;
  readonly interpolationCtx?: (
    tree: Root,
    file: VFile,
  ) => Record<string, unknown>;
}

export const contributeKeyword = "contribute" as const;
export const includeKeyword = "include" as const;
export const importKeyword = "import" as const;

function defaultIsSpecBlock(code: Code) {
  return code.lang === contributeKeyword || code.lang === includeKeyword ||
    code.lang === importKeyword;
}

export function isIncludeSpecBlock(spec: ContributeSpec) {
  return spec.lang === includeKeyword || spec.lang === importKeyword ||
      spec.identity === includeKeyword || spec.identity === importKeyword ||
      spec.contributeQPI.getFlag("I", includeKeyword, importKeyword)
    ? true
    : false;
}

function contributeSpecs(
  code: Code,
  contributeFM: CodeFrontmatter,
  interpolationCtx?: Record<string, unknown>,
) {
  const contributeQPI = queryPosixPI<ContributePiFlags>(
    contributeFM.pi,
    undefined,
    { zodSchema: contributePiFlagsSchema },
  );

  // Default base to "." if not provided.
  if (!contributeQPI.hasFlag("base", "B")) contributeFM.pi.flags["base"] = ".";

  const contributeSF = contributeQPI.safeFlags();
  if (!contributeSF.success) {
    addIssue(code, {
      severity: "error",
      message:
        `Error reading contribute flags (line ${code.position?.start.line}):\n${
          z.prettifyError(contributeSF.error)
        }`,
      error: contributeSF.error,
    });
  }

  let specsSrc = code.value;
  if (contributeSF.success && contributeSF.data.interpolate) {
    specsSrc = safeInterpolate(specsSrc, {
      code,
      contributeFM,
      ...interpolationCtx,
    });
  }

  return {
    contributeFM,
    contributeQPI,
    contributeSF,
    specsSrc,
  };
}

export type ExternalResource<N extends Node> = N & {
  includeResources: ResourceProvenance[];
  acquireResources: () => Promise<void>;
  resourcesAcquired: boolean;
};

export function isExternalResource<N extends Node>(
  node: Node,
): node is ExternalResource<N> {
  const n = node as Any;
  return !!(
    n &&
    typeof n === "object" &&
    Array.isArray(n.includeResources) &&
    n.includeResources.length > 0 &&
    typeof n.acquireResources === "function"
  );
}

export const interpolatedCodeMeta = dataBag<
  "isInterpolatedCodeMeta",
  { original: string },
  Code
>("isInterpolatedCodeMeta");

function scanMetaForIncludes(meta: string): string[] {
  // Supports:
  //   --include path
  //   --include=path
  //   --include="path with spaces"
  //   --include='path with spaces'
  const re = /(?:^|\s)--include(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
  const out: string[] = [];
  for (let m = re.exec(meta); m; m = re.exec(meta)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (v) out.push(v);
  }
  return out;
}

export function externalResource(
  code: Code,
  interpolationCtx?: Record<string, unknown>,
) {
  const originalMeta = code.meta;
  if (!originalMeta?.includes("--include")) return;

  if (interpolationCtx) {
    code.meta = safeInterpolate(originalMeta, { code, ...interpolationCtx });
    interpolatedCodeMeta.attach(code, { original: originalMeta });
  }

  const codeFM = codeFrontmatter(code);
  if (!codeFM) return;

  // Collect includes from PI flags (if repeated flags are preserved by the parser),
  // then fallback to scanning meta to ensure repeated --include are captured.
  const includes: string[] = [];

  const piInclude = (codeFM.pi.flags as Any)?.["include"];
  if (typeof piInclude === "string" && piInclude.trim()) {
    includes.push(piInclude.trim());
  } else if (Array.isArray(piInclude)) {
    for (const v of piInclude) {
      if (typeof v === "string" && v.trim()) includes.push(v.trim());
    }
  }

  const metaToScan = code.meta ?? "";
  if (metaToScan.includes("--include")) {
    includes.push(...scanMetaForIncludes(metaToScan));
  }

  // De-dupe exact repeats while preserving order.
  const seen = new Set<string>();
  const includeList = includes.filter((p) => {
    if (!p) return false;
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  if (!includeList.length) return;

  const erNode = code as ExternalResource<Code>;
  erNode.includeResources = includeList.map((p) => provenanceFromPath(p));
  erNode.resourcesAcquired = false;

  erNode.acquireResources = async () => {
    const parts: string[] = [];
    let allOk = true;

    for (const includePath of includeList) {
      const r = resourceFromPath(includePath);

      if (r.strategy.encoding !== "utf8-text") {
        addIssues(code, [{
          message:
            `MIME '${r.provenance.mimeType}' is not text, ${r.provenance.path} not injected into code[${code.lang}].value`,
          severity: "info",
        }]);
        allOk = false;
        continue;
      }

      const text = await r.safeText();
      if (typeof text === "string") {
        parts.push(text);
      } else {
        addIssues(code, [{
          message:
            `Unable to resolve include content ${r.provenance.path} (${r.provenance.mimeType})`,
          severity: "error",
          error: text,
        }]);
        allOk = false;
      }
    }

    if (parts.length) {
      // Simple concatenation with a single newline between parts.
      code.value = parts.join("\n");
      erNode.resourcesAcquired = allOk;
    } else {
      erNode.resourcesAcquired = false;
    }
  };
}

export type ExtensionImportResult<
  M extends Record<string, unknown> = Record<string, unknown>,
> =
  & Readonly<{ resource: ResourceProvenance }>
  & Readonly<{
    /** Original specifier (path/URL). */
    specifier: string;
    /** Raw imported module (typed for callers). */
    module: M;
  }>;

export type Extension<
  N extends Node,
  M extends Record<string, unknown> = Record<string, unknown>,
> = N & {
  extensionResource: ResourceProvenance;
  extensionImported?: ExtensionImportResult<M>;
  importExtension: () => Promise<ExtensionImportResult<M> | undefined>;
};

export function isExtension<
  N extends Node,
  M extends Record<string, unknown> = Record<string, unknown>,
>(node: Node): node is Extension<N, M> {
  return !!(node && typeof node === "object" && "extensionResource" in node);
}

export function extension<
  M extends Record<string, unknown> = Record<string, unknown>,
>(
  code: Code,
  interpolationCtx?: Record<string, unknown>,
) {
  const originalMeta = code.meta;
  if (!originalMeta) return;
  if (!originalMeta.includes("--extension")) return;

  if (interpolationCtx) {
    code.meta = safeInterpolate(originalMeta, { code, ...interpolationCtx });
  }

  const fm = codeFrontmatter(code);
  if (!fm) return;

  const ext = fm.pi.flags["extension"];
  if (typeof ext !== "string" || !ext.trim()) return;

  const specifier = ext.trim();
  const provenance = provenanceFromPath(specifier);

  const node = code as unknown as Extension<Code, M>;
  node.extensionResource = provenance;
  node.extensionImported = undefined;

  node.importExtension = async () => {
    try {
      if (node.extensionImported) return node.extensionImported;

      const mod = await import(specifier);

      node.extensionImported = {
        resource: provenance,
        specifier,
        module: mod as M,
      } satisfies ExtensionImportResult<M>;

      return node.extensionImported;
    } catch (err) {
      addIssues(code, [
        {
          severity: "error",
          message:
            `Unable to import extension '${specifier}' (code=EXT_IMPORT_FAILED).`,
          error: err,
        } satisfies NodeIssue,
      ]);
      return undefined;
    }
  };
}

export const prepareExternalContributions: Plugin<[ContributeOptions?], Root> =
  (
    options,
  ) => {
    const isSpecBlock = options?.isSpecBlock ?? defaultIsSpecBlock;
    const interpolationCtx = options?.interpolationCtx;

    return (tree, vfile) => {
      visit(tree, "code", (code: Code) => {
        if (!isSpecBlock(code)) {
          // Inline behaviors for a single code block.
          if (code.meta?.includes("--include")) {
            externalResource(code, interpolationCtx?.(tree, vfile));
          } else if (code.meta?.includes("--extension")) {
            extension(code, interpolationCtx?.(tree, vfile));
          }
          return;
        }

        if (isContributeSpec(code)) return;

        const iCtx = interpolationCtx?.(tree, vfile);

        const contributeFM = codeFrontmatter(code, {
          cacheableInCodeNodeData: false,
          transform: iCtx
            ? ((lang, meta) => {
              if (meta) meta = safeInterpolate(meta, { code, ...iCtx });
              return { lang: lang ?? undefined, meta: meta ?? undefined };
            })
            : undefined,
        });

        if (!contributeFM) return;

        const target = contributeFM.pi.pos[0];
        if (!target) {
          addIssue(code, {
            severity: "error",
            message:
              `Contribute spec block is missing a target identity (expected \`\`\`${code.lang} <target>).`,
          });
          return;
        }

        const cs = contributeSpecs(code, contributeFM, iCtx);
        const directive = code as CodeDirectiveCandidate<
          string,
          typeof contributeKeyword
        >;
        directive.isCodeDirectiveCandidate = true;
        directive.directive = contributeKeyword;
        directive.identity = target;
        directive.instructions = contributeFM as unknown as InstructionsResult;
        assert(isCodeDirectiveCandidate(directive));

        const node = code as ContributeSpec;
        node.identity = target; // same as above, it's the same instance
        node.contributeFM = cs.contributeFM;
        node.contributeQPI = cs.contributeQPI;
        node.contributeSF = cs.contributeSF;

        node.contributables = (opts) => {
          if (!cs.contributeSF.success) {
            addIssue(node, {
              message:
                `Invalid codeFM ${node.lang} ${node.meta} (line ${node.position?.start.line})`,
              severity: "error",
              error: cs.contributeSF.error,
            });
            return [] as unknown as ReturnType<
              ContributeSpec["contributables"]
            >;
          }

          return resourceContributions(cs.specsSrc, {
            labeled: opts?.labeled ?? cs.contributeSF.data.labeled ??
              isIncludeSpecBlock(node),
            fromBase: cs.contributeSF.data.base,
            destPrefix: opts?.destPrefix ?? cs.contributeSF.data.dest,
            allowUrls: opts?.allowUrls ?? false,
            resolveBasePath: opts?.resolveBasePath,
            transform: opts?.transform,
          });
        };
      });
    };
  };

export type IncludesSpec = Code & {
  includables: Iterable<Node>;
  resolveIncludes: () => Promise<void>;
};

export function isIncludesSpec(code: Node): code is IncludesSpec {
  const c = code as unknown as Partial<IncludesSpec>;
  return !!(c && typeof c === "object" && Array.isArray(c.includables)) &&
    typeof c.resolveIncludes === "function";
}

export type IncludedNode<N extends Node> = N & {
  include: ResourceContribution<ContributeSpecLine>;
  acquireContent: () => Promise<void>;
  isContentAcquired: boolean;
};

export function isIncludedNode<N extends Node>(
  node: Node,
): node is IncludedNode<N> {
  return node && "include" in node && node.include ? true : false;
}

export interface IncludeNodeInsertOptions {
  readonly isSpecBlock: (
    node: ContributeSpec,
    vfile: VFile,
    root: Root,
  ) => false | Parameters<ContributeSpec["contributables"]>[0];
  readonly generatedNode?: (
    ctx: {
      readonly rc: ResourceContribution<ContributeSpecLine>;
      readonly specs: ContributeSpec;
    },
  ) => IncludedNode<Node>;
  readonly retainAfterInjections?: (node: Node) => boolean;
  readonly consumeEdges?: (
    edges: { generatedBy: Node; included: Node }[],
    vfile: VFile,
    tree: Root,
  ) => void;
}

const generatedCodeNode: IncludeNodeInsertOptions["generatedNode"] = (ctx) => {
  const {
    rc: {
      destPath: destPathRaw,
      origin: {
        label: lang,
        lineNumInRawInstructions: pathLine,
        meta: metaRaw,
      },
      provenance,
      strategy,
    },
    specs,
  } = ctx;

  const position = specs.position
    ? {
      line: specs.position.start.line + pathLine,
      column: 1,
      offset: undefined,
    }
    : undefined;

  let directive: string | undefined;
  let rewritePathFind: string | undefined;
  let rewritePathRepl: string | undefined;

  const rewrittenMeta = rewrittenInstructions(metaRaw, {
    onFlag: (flag, value) => {
      switch (flag) {
        case "directive": {
          if (typeof value === "string") directive = value;
          return "extract";
        }
        case "rewrite-path-find": {
          if (typeof value === "string") rewritePathFind = value;
          return "extract";
        }
        case "rewrite-path-replace": {
          if (typeof value === "string") rewritePathRepl = value;
          return "extract";
        }
        default:
          return "retain";
      }
    },
    dashedOnly: true,
  });

  const destPathRewriter = rewritePathFind && rewritePathRepl
    ? createRegexRewriter(rewritePathFind, rewritePathRepl, { cache: true })
    : undefined;

  const destPath = destPathRewriter
    ? destPathRewriter(destPathRaw)
    : destPathRaw;
  if (destPath !== destPathRaw) {
    (ctx.rc.destPath as string) = destPath;
  }

  const result: IncludedNode<Code> = {
    type: "code",
    lang,
    meta: directive
      ? `${directive} ${destPath} ${rewrittenMeta}`
      : `${destPath} ${metaRaw}`,
    value:
      `should be replaced by text value of ${destPath} (${provenance.mimeType})`,
    position: position ? { start: position, end: position } : undefined,
    include: ctx.rc,
    isContentAcquired: false,
    acquireContent: async () => {
      if (strategy.encoding !== "utf8-text") {
        addIssues(result, [{
          message:
            `MIME '${provenance.mimeType}' is not text, ${provenance.path} not injected into code[${lang}].value`,
          severity: "info",
        }]);
        return;
      }

      const r = provenanceResource(ctx.rc);
      const text = await r.safeText();
      if (typeof text === "string") {
        result.value = text;
        result.isContentAcquired = true;
      } else {
        addIssues(result, [{
          message:
            `Unable to resolve include content ${r.provenance.path} (${r.provenance.mimeType})`,
          severity: "error",
          error: text,
        }]);
      }
    },
  };

  return result;
};

export const prepareIncludedNodes: Plugin<[IncludeNodeInsertOptions], Root> = (
  options,
) => {
  const { isSpecBlock } = options;
  const generatedNode = options?.generatedNode ?? generatedCodeNode;

  return (tree: Root, vfile: VFile) => {
    const { retainAfterInjections = () => true } = options ?? {};

    const mutations: {
      // deno-lint-ignore no-explicit-any
      parent: any;
      index: number;
      injected: Node[];
      mode: "retain-after-injections" | "remove-before-injections";
    }[] = [];

    visit(tree, "code", (code: Code, index, parent) => {
      if (parent == null || index == null) return;
      if (!isContributeSpec(code)) return;

      const isb = isSpecBlock(code, vfile, tree);
      if (!isb) return;

      const mode = retainAfterInjections == undefined
        ? "retain-after-injections" as const
        : (retainAfterInjections(code)
          ? "retain-after-injections" as const
          : "remove-before-injections" as const);

      const generated: IncludedNode<Node>[] = [];
      const contrib = code.contributables(isb);

      for (const rc of contrib.provenance()) {
        const newNode = generatedNode({ rc, specs: code });
        generated.push(newNode);
      }

      if (generated.length) {
        const node = code as unknown as IncludesSpec;
        node.includables = generated;
        node.resolveIncludes = async () => {
          for (const include of generated) {
            await include.acquireContent();
          }
        };
        assert(isIncludesSpec(code));

        if (options?.consumeEdges) {
          options.consumeEdges(
            generated.map((g) => ({ generatedBy: code, included: g })),
            vfile,
            tree,
          );
        }

        mutations.push({ parent, index, injected: generated, mode });
      }
    });

    // Apply mutations after traversal, from right to left.
    mutations.sort((a, b) => b.index - a.index);

    for (const { parent, index, injected, mode } of mutations) {
      if (mode === "remove-before-injections") {
        // Replace spec node with injected nodes
        parent.children.splice(index, 1, ...injected);
      } else {
        // retain-after-injections: keep spec; insert injected nodes after it
        parent.children.splice(index + 1, 0, ...injected);
      }
    }

    return tree;
  };
};
