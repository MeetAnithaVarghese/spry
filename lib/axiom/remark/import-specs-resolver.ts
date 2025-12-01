/**
 * This importables module parses “import spec” code blocks and turns them into
 * typed import instructions that downstream plugins can materialize into real
 * mdast nodes or graph edges.
 *
 * Responsibilities:
 * - Parse PI-style flags from code frontmatter (e.g. `--base`, `--bin`)
 * - Interpret each line inside a spec block as an import directive:
 *       <label> <path|glob|url> [flags…]
 * - Resolve candidates into `ResourceProvenance` records
 * - Provide `prepareCodeNodes()` which materializes generated code nodes
 *
 * It does **not** insert the generated nodes into the MDAST — that is handled
 * by the companion plugin in `code-insert.ts`. Instead, this module only:
 *   • Detects import-spec blocks
 *   • Attaches parsed metadata (`importSpecs`)
 *   • Provides a generator for “expand these specs into code nodes”
 *
 * The actual insertion/replacement of nodes is done by
 * `insertCodeImportNodes` in `code-insert.ts`.
 */
import { join, relative } from "@std/path";
import z from "@zod/zod";
import type { Code, Root } from "types/mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";
import { safeInterpolate } from "../../interpolate/safe.ts";
import { relativeUrlAsFsPath } from "../../universal/content-acquisition.ts";
import {
  flexibleTextSchema,
  instructionsFromText,
  InstructionsResult,
  mergeFlexibleText,
  PosixPIQuery,
  queryPosixPI,
} from "../../universal/posix-pi.ts";
import {
  detectMimeFromPath,
  ResourceProvenance,
  strategyDecisions,
  tryParseHttpUrl,
} from "../../universal/resource.ts";
import { CodeFrontmatter, codeFrontmatter } from "../mdast/code-frontmatter.ts";
import { addIssue } from "../mdast/node-issues.ts";
import { ImportPlaceholder } from "./import-placeholders-generator.ts";

export const codeImportPiFlagsSchema = z.object({
  base: flexibleTextSchema.optional(),
  interpolate: z.boolean().optional(),

  // shortcuts
  /* base */ B: flexibleTextSchema.optional(),
  /* interpolate */ I: z.boolean().optional(),
}).transform((raw) => {
  return {
    base: mergeFlexibleText(raw.base, raw.B),
    interpolate: raw.I ?? raw.interpolate,
  };
});

export type CodeImportPiFlags = z.infer<typeof codeImportPiFlagsSchema>;

// the "label" is treated as "language"
export type CodeImportSpecProvenance = ResourceProvenance & {
  readonly base: string;
  readonly candidatePath: string;
  readonly rawInstructions: string;
  readonly ir: InstructionsResult;
  readonly ppiq: PosixPIQuery;
  readonly lineNumInRawInstructions: number;
};

/** Shape of the injectedNode metadata we attach to mdast.Code.data. */
export type CodeImport = Code & {
  identity?: string;
  importFM: CodeFrontmatter;
  importQPI: ReturnType<typeof queryPosixPI<CodeImportPiFlags>>;
  importSF: ReturnType<
    ReturnType<
      typeof queryPosixPI<CodeImportPiFlags>
    >["safeFlags"]
  >;
  importable: CodeImportSpecProvenance[];
};

export function isCodeImport(code: Code): code is CodeImport {
  return "importFM" in code && code.importFM && "importQPI" in code &&
      code.importQPI && "importSF" in code && code.importSF &&
      "importable" in code &&
      code.importable
    ? true
    : false;
}

/**
 * Parse PI-style flags declared in the code fence’s metadata/frontmatter.
 *
 * - Applies `queryPosixPI` using the `codeImportPiFlagsSchema`.
 * - Produces the validated safe-flags (`importSF`).
 * - Emits an issue on failure.
 *
 * @param code     The code-fence node containing PI text.
 * @param importFM Parsed frontmatter from that node.
 *
 * @returns A struct with parsed PI query + safe-flag results.
 */
export function codeImportSpecs(
  code: Code,
  importFM: CodeFrontmatter,
  interpolationCtx?: Record<string, unknown>,
) {
  const importQPI = queryPosixPI<CodeImportPiFlags>(
    importFM.pi,
    undefined,
    {
      zodSchema: codeImportPiFlagsSchema,
    },
  );
  if (!importQPI.hasFlag("base", "B")) importFM.pi.flags["base"] = ".";
  const importSF = importQPI.safeFlags();
  if (!importSF.success) {
    addIssue(code, {
      severity: "error",
      message:
        `Error reading code spawnable flags (line ${code.position?.start.line}):\n${
          z.prettifyError(importSF.error)
        }`,
      error: importSF.error,
    });
  }

  let specsSrc = code.value;
  if (importSF.success && importSF.data.interpolate) {
    specsSrc = safeInterpolate(specsSrc, {
      code,
      importFM,
      ...interpolationCtx,
    });
  }

  const lines = specsSrc.split(/\r\n|\r|\n/);
  return {
    importFM,
    importQPI,
    importSF,
    specLines: lines.at(-1) === "" ? lines.slice(0, -1) : lines,
  };
}

/**
 * Yield `CodeImportSpecProvenance` entries from an import spec code block.
 *
 * Each non-empty line in the code value is interpreted as:
 *
 *   `<label> <pathOrGlobOrUrl> [flags…]`
 *
 * - `label` is treated as the language of the generated `code` node.
 * - The path/URL is resolved against any `base` flags or block-level base.
 * - Invalid lines are recorded as issues on the source code node.
 *
 * @param code The source `code` node containing import directives.
 * @param cis  Parsed import spec info from {@link codeImportSpecs}.
 * @yields Provenance records for each resolved import candidate.
 */
export function* resourceProvenanceFromCode(
  code: Code,
  cis: ReturnType<typeof codeImportSpecs>,
) {
  if (!cis || !cis.importSF.success) return;

  const { importSF, specLines } = cis;
  const codeStartLine = code.position?.start.line ?? 0;
  const { base: codeImportBase } = importSF.data;

  let lineNum = 0;
  for (const line of specLines) {
    lineNum++;
    const ir = instructionsFromText(line);
    const ppiq = queryPosixPI(ir.pi);
    if (ir.pi.args.length < 2) {
      addIssue(code, {
        severity: "error",
        message: `Import spec \`${line}\` on line ${
          codeStartLine + lineNum
        }) is not valid (must have "<label> <pathOrGlobOrUrl> ..."), skipping.`,
      });
    }

    const [label, candidatePath] = ir.pi.args;
    const common: Pick<
      CodeImportSpecProvenance,
      | "rawInstructions"
      | "ir"
      | "ppiq"
      | "candidatePath"
      | "lineNumInRawInstructions"
    > = {
      rawInstructions: line,
      ir,
      ppiq,
      candidatePath,
      lineNumInRawInstructions: lineNum,
    };

    const specBases = ppiq.getTextFlagValues("base");
    const bases = specBases.length > 0 ? specBases : codeImportBase;
    if (tryParseHttpUrl(candidatePath)) {
      const mime = detectMimeFromPath(candidatePath);
      yield {
        base: bases.length > 0 ? bases[0] : "",
        path: candidatePath,
        label,
        ...(mime ? { mimeType: mime } : null),
        ...common,
      } satisfies CodeImportSpecProvenance;
    } else {
      for (const base of bases) {
        const mime = detectMimeFromPath(candidatePath);
        const path = join(base, candidatePath);
        yield {
          base,
          path,
          label,
          ...(mime ? { mimeType: mime } : null),
          ...common,
        } satisfies CodeImportSpecProvenance;
      }
    }
  }
}

/**
 * Materialize import directives into actual MDAST `code` nodes.
 *
 * For each provenance record:
 *   - Compute a `meta` string representing a logical import path + "--import"
 *   - Optionally read the local file’s TEXT content into the `value`
 *     (skips binary or flagged-as-binary types)
 *   - Approximate a position mapping so users can trace back to the
 *     originating instruction
 *
 * Output objects include:
 *   - `generated`: the new code node
 *   - `provenance`: the resolved import target and metadata
 *   - `strategy`: the chosen ResourceStrategy ("local-fs" or URL)
 *
 * This function **does not update the tree**. The caller (code-insert.ts)
 * decides where to insert the generated nodes.
 *
 * @param code Original spec code node.
 * @param specs Parsed importSpecs attached by resolveImportSpecs.
 * @param options Controls whether to read local text into node.value.
 *
 * @yields Objects representing materialized code nodes.
 */
export function* prepareCodeNodes(specs: CodeImport) {
  for (const sd of strategyDecisions(specs.importable)) {
    const { provenance, strategy } = sd;
    const {
      path,
      label: language,
      base,
      lineNumInRawInstructions: pathLine,
    } = provenance;
    const rest = sd.provenance.ir.pi.args.slice(2);
    let meta: string[];

    if (strategy.target === "local-fs") {
      meta = [relative(base, path), "--import", path, ...rest];
    } else {
      const url = strategy.url?.toString() ?? path;
      meta = [relativeUrlAsFsPath(base, url), "--import", url, ...rest];
    }

    const position = specs.position
      ? {
        line: specs.position.start.line + pathLine,
        column: 1,
        offset: undefined,
      }
      : undefined;

    const generated: Code & ImportPlaceholder = {
      type: "code",
      isImportPlaceholder: true,
      lang: language,
      meta: meta.join(" ").trim(),
      value: `import placeholder: ${specs.lang} ${specs.meta}`,
      // Optional position mapping approximate to spec line:
      position: position ? { start: position, end: position } : undefined,
      provenance,
      isBinaryHint: language === "utf8" ||
        (provenance.ppiq.getFlag("is-binary", "binary", "bin") ?? false),
    };

    yield generated;
  }
}

export interface CodeImportOptions {
  /**
   * Decide whether a code node is an import/spec block and how to treat it.
   * If omitted, the default behavior is:
   *   - If the lang is `import`, return true`.
   *   - Otherwise, return `false`.
   */
  readonly isSpecBlock?: (node: Code) => boolean;

  /**
   * Key/value pairs to pass into the safe interpolation context that base
   * dirs or other values can use.
   */
  readonly interpolationCtx?: (
    tree: Root,
    file: VFile,
  ) => Record<string, unknown>;
}

/**
 * Default heuristic for deciding whether a code block is a "spec/import"
 * block that should be expanded:
 *
 * - use parseCodeFrontmatterFromCode(node)
 * - check for a lang called "import"
 *
 * You can override this via plugin options.
 */
function defaultIsSpecBlock(code: Code) {
  if (code.lang === "import") {
    if (!code.meta?.trim()) {
      code.meta = "--base .";
    }
    return true;
  }
  return false;
}

/**
 * remark plugin that *detects* import-spec code blocks and attaches
 * parsed import metadata to them.
 *
 * This plugin does NOT insert generated code nodes.
 * Instead, it:
 *   - Identifies spec blocks using `isSpecBlock` (default: lang==="import")
 *   - Parses code-frontmatter PI flags
 *   - Parses each line of the block into import directives
 *   - Resolves base paths and URLs
 *   - Attaches `importSpecs` to the code node, including:
 *       • importFM: parsed frontmatter
 *       • importQPI: raw flag query
 *       • importSF: validated flag values
 *       • importable: per-line provenance records
 *
 * Downstream plugin:
 *   The companion plugin `insertCodeImportNodes` (from code-insert.ts)
 *   consumes `importSpecs` and actually generates + inserts new nodes.
 */
export const resolveImportSpecs: Plugin<[CodeImportOptions?], Root> = (
  options,
) => {
  const isSpecBlock = options?.isSpecBlock ?? defaultIsSpecBlock;
  const interpolationCtx = options?.interpolationCtx;

  return (tree, vfile) => {
    visit(tree, "code", (code: Code) => {
      const mode = isSpecBlock(code); // has side effects: might get mutated
      const iCtx = interpolationCtx?.(tree, vfile);
      const importFM = codeFrontmatter(code, {
        cacheableInCodeNodeData: false,
        transform: iCtx
          ? ((lang, meta) => {
            if (meta) {
              meta = safeInterpolate(meta, { code, ...iCtx });
            }
            return { lang: lang ?? undefined, meta: meta ?? undefined };
          })
          : undefined,
      });

      if (!importFM || !mode) return; // not a spec block

      const cis = codeImportSpecs(code, importFM, iCtx);
      const importNode = code as CodeImport;
      importNode.identity = importFM.pi.pos[0];
      importNode.importFM = importFM;
      importNode.importQPI = cis.importQPI;
      importNode.importSF = cis.importSF;
      importNode.importable = Array.from(resourceProvenanceFromCode(code, cis));
    });
  };
};

export default resolveImportSpecs;
