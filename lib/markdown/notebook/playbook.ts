/**
 * playbook.ts — higher-level orchestration over notebook.ts
 *
 * This module defines the **Playbook** abstraction — a structured, executable layer
 * built on top of the lower-level **Notebook** model from `notebook.ts`.
 *
 * Whereas `notebook.ts` focuses on parsing Markdown into discrete *cells*
 * (code vs. prose) and preserving the syntactic structure, `playbook.ts`
 * focuses on **semantic enrichment** and **orchestration**:
 *
 * - It attaches contextual **instructions** (documentation, comments, markdown regions)
 *   to nearby code cells, making each block of code self-explanatory and executable.
 * - It identifies notebook-level regions such as:
 *     • `instructions` — header commentary before the first code cell.
 *     • `appendix` — explanatory material after the last code cell.
 * - It treats Markdown headings or horizontal rules as **instruction delimiters**,
 *   enabling analysts to author prose that becomes structured annotations for code.
 * - It introduces **PlaybookCodeCell** and **Playbook** types that combine documentation
 *   and executable logic in one model — the building blocks for low-code, AI-ready
 *   “executable documents.”
 *
 * Conceptually:
 * - `Notebook` (from notebook.ts) = raw parsed Markdown + cells + provenance.
 * - `Playbook` (from this module)    = Notebook + instructions + executable semantics.
 *
 * Together, they form the foundation for programmable, human-readable documents that
 * analysts, engineers, and AI agents can interpret and act upon.
 *
 * ----------------------------------------------------------
 * Public API summary
 * ----------------------------------------------------------
 *
 * • **playbooks(...)**
 *   Converts a stream of Notebooks into structured Playbooks.
 *   For each Notebook:
 *     - Builds header/appendix instructions from AST regions.
 *     - Buffers markdown regions between delimiters (e.g., “##”) and
 *       associates them with the next code cell as documentation.
 *   Default delimiter: `{ kind: "heading", level: 2 }`
 *
 * • **safeFrontmatter(schema, input)**
 *   Validates Notebook frontmatter using Zod 4 (`safeParse`).
 *   Pushes structured Issue objects for any schema violations.
 *   Returns an async stream of `{ notebook, zodParseResult }`.
 *
 * • **mutateDocCodeCells(callback, input)**
 *   Iterates over Playbooks and applies a mutation callback to each
 *   documented code cell, allowing enrichment, linting, or transformation.
 *   The callback receives a context object with:
 *     - `pb`: current Playbook
 *     - `cellIndex`: index within the Playbook
 *     - `registerIssue(issue)`: function to record issues
 *
 * • **pipedPlaybookCodeCellMutators(mutators)**
 *   Utility to compose multiple mutators into one function,
 *   applying them sequentially for modular transformations.
 *
 * ----------------------------------------------------------
 * Why this layer exists
 * ----------------------------------------------------------
 *
 * `playbook.ts` bridges the gap between **structured Markdown parsing**
 * and **AI/analyst-facing execution frameworks**:
 * - Converts static prose into typed, machine-readable “instructions.”
 * - Makes each code cell an explainable, auditable unit.
 * - Enables automated reasoning, documentation generation,
 *   and human-in-the-loop low-code editing.
 * - Forms the semantic substrate for “low-code AI playbooks” and
 *   “programmable compliance guides” that can execute reproducibly.
 *
 * ----------------------------------------------------------
 * Example conceptual flow
 * ----------------------------------------------------------
 *
 * Markdown file  →  Notebook (cells + frontmatter)
 *                →  Playbook (cells + instructions + appendix)
 *                →  Mutators (linting, validation, transformation)
 *                →  Execution (runtime, AI agent, or export)
 *
 * ----------------------------------------------------------
 * Typical usage
 * ----------------------------------------------------------
 *
 * ```ts
 * import { notebooks } from "./notebook.ts";
 * import { playbooks, safeFrontmatter } from "./playbook.ts";
 * import { z } from "jsr:@zod/zod@4";
 *
 * // Define frontmatter schema
 * const fmSchema = z.object({ title: z.string(), author: z.string().optional() });
 *
 * // Parse Markdown into Playbooks
 * for await (const pb of playbooks(notebooks({ provenance: "demo.md", content: src }))) {
 *   console.log(pb.instructions?.text);  // header prose
 *   for (const cell of pb.cells) {
 *     if (cell.kind === "code") {
 *       console.log(cell.instructions?.text); // doc prose before code
 *     }
 *   }
 * }
 *
 * // Optionally validate frontmatter
 * for await (const { notebook, zodParseResult } of safeFrontmatter(fmSchema, notebooks(...))) {
 *   if (!zodParseResult.success) console.error(notebook.issues);
 * }
 * ```
 *
 * ----------------------------------------------------------
 * Layer summary
 * ----------------------------------------------------------
 *
 * - **notebook.ts** — parses Markdown into syntactic cells with provenance.
 * - **playbook.ts** — enriches notebooks with semantic structure and
 *   documentation-awareness for execution and automation.
 *
 * This separation mirrors a compiler pipeline:
 * - notebook.ts = parser / AST builder
 * - playbook.ts = semantic analyzer / enricher
 */
import { z } from "jsr:@zod/zod@4";
import { Root, RootContent } from "npm:@types/mdast@4";
import { toString as mdToString } from "npm:mdast-util-to-string@^4";
import {
  Asyncish,
  isAsyncIterable,
  toAsync,
} from "../../universal/collectable.ts";
import {
  Cell,
  CodeCell,
  Issue,
  MarkdownCell,
  Notebook,
} from "../governedmd.ts";
import { remarkProcessor } from "./notebook.ts";

/** Instructions delimiter configuration */
export type InstructionsDelimiter =
  | { kind: "hr" }
  | { kind: "heading"; level?: 1 | 2 | 3 | 4 | 5 | 6 };

/** Strongly-typed instruction payload for a block or module region */
export interface Instructions {
  readonly nodes: ReadonlyArray<RootContent>;
  readonly markdown: string;
  readonly text: string;
}

/** A documented code cell: base CodeCell plus optional instructions */
export type PlaybookCodeCell<
  Provenance,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
> = CodeCell<Provenance, Attrs> & { readonly instructions?: Instructions };

/** Discriminated union: narrowing by `kind` gives you the right shape */
export type PlaybookCell<
  Provenance,
  Attrs extends Record<string, unknown> = Record<string, unknown>,
> = PlaybookCodeCell<Provenance, Attrs> | MarkdownCell<Provenance>;

/** Notebook annotated with header/appendix instructions and documented cells */
export type Playbook<
  Provenance,
  FM extends Record<string, unknown>,
  Attrs extends Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
> = {
  readonly notebook: Notebook<Provenance, FM, Attrs, I>;
  readonly cells: ReadonlyArray<PlaybookCell<Provenance, Attrs>>;
  readonly instructions?: Instructions;
  readonly appendix?: Instructions;
};

function stringifyNodesForInstr(nodes: ReadonlyArray<RootContent>): string {
  const root: Root = { type: "root", children: nodes.slice() as RootContent[] };
  return String(remarkProcessor.stringify(root));
}

function textOfNodesForInstr(nodes: ReadonlyArray<RootContent>): string {
  return nodes.map((n) => mdToString(n)).join("\n").trim();
}

function mkInstructions(
  nodes: ReadonlyArray<RootContent>,
): Instructions | undefined {
  if (!nodes.length) return undefined;
  return {
    nodes,
    markdown: stringifyNodesForInstr(nodes),
    text: textOfNodesForInstr(nodes),
  };
}

function isDelimiterNode(
  n: RootContent,
  delim: InstructionsDelimiter,
): boolean {
  if (delim.kind === "hr") return n.type === "thematicBreak";
  if (n.type !== "heading") return false;
  return typeof delim.level === "number" ? n.depth === delim.level : true;
}

/**
 * playbooks
 * -------------------
 * Uses the mdast cache inside Notebook.ast to:
 * - Build notebook-level `instructions` (header) from ast.nodesBeforeFirstCode
 * - Build notebook-level `appendix`   from ast.nodesAfterLastCode
 * - Walk markdown cells (via ast.mdastByCell) with a buffer that resets at delimiters.
 *   When a code cell is hit, attach the buffered nodes as `instructions` to that cell.
 *
 * Default delimiter: heading level 2 (##).
 */
export async function* playbooks<
  Provenance,
  FM extends Record<string, unknown>,
  Attrs extends Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  input:
    | AsyncIterable<Notebook<Provenance, FM, Attrs, I>>
    | Iterable<Notebook<Provenance, FM, Attrs, I>>,
  delimiter: InstructionsDelimiter = { kind: "heading", level: 2 },
): AsyncIterable<Playbook<Provenance, FM, Attrs, I>> {
  const iterable: AsyncIterable<Notebook<Provenance, FM, Attrs, I>> =
    isAsyncIterable<
        Notebook<Provenance, FM, Attrs, I>
      >(input)
      ? (input as AsyncIterable<Notebook<Provenance, FM, Attrs, I>>)
      : (async function* () {
        for (const n of input as Iterable<Notebook<Provenance, FM, Attrs, I>>) {
          yield n;
        }
      })();

  for await (const nb of iterable) {
    const { mdastByCell, nodesBeforeFirstCode, nodesAfterLastCode } = nb.ast;

    // Notebook-level regions (ignore delimiters for these)
    const headerInstr = mkInstructions(nodesBeforeFirstCode);
    const appendixInstr = mkInstructions(nodesAfterLastCode);

    // Per-code-cell buffer logic over markdown cells
    const buffer: RootContent[] = [];
    const outCells: PlaybookCell<Provenance, Attrs>[] = [];

    for (let i = 0; i < nb.cells.length; i++) {
      const c = nb.cells[i] as unknown as Cell<Provenance, Attrs>;
      const nodes = mdastByCell[i]; // null for code, mdast[] for markdown

      if (nodes) {
        // markdown cell -> feed nodes into buffer with delimiter behavior
        for (const n of nodes) {
          if (isDelimiterNode(n, delimiter)) {
            buffer.length = 0; // clear
            if (delimiter.kind === "heading" && n.type === "heading") {
              buffer.push(n); // seed with heading
            }
            continue;
          }
          buffer.push(n);
        }
        outCells.push(c); // unchanged markdown cell
        continue;
      }

      // code cell -> attach current buffer (if any), then clear
      const instr = mkInstructions(buffer);
      const docCell: PlaybookCell<Provenance, Attrs> =
        c.kind === "code" && instr ? { ...c, instructions: instr } : c;
      outCells.push(docCell);
      buffer.length = 0;
    }

    yield {
      notebook: nb,
      cells: outCells,
      instructions: headerInstr,
      appendix: appendixInstr,
    };
  }
}

/**
 * Validate frontmatter (Zod 4, safeParse). Mutates `nb.issues`.
 * Carries a custom issue shape `I` that extends base `Issue` (defaults to `Issue`).
 *
 * DX:
 * - Juniors: just call safeFrontmatter(schema, notebooks(...)).
 * - Seniors: provide a custom `I` with extra fields (e.g., origin) and type your stream as Notebook<..., I>.
 */
export async function* safeFrontmatter<
  Provenance,
  FM extends Record<string, unknown>,
  Attrs extends Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  fmSchema: z.ZodSchema<FM>,
  input: Asyncish<Notebook<Provenance, FM, Attrs, I>>,
) {
  for await (const nb of toAsync(input)) {
    const zodParseResult = fmSchema.safeParse(nb.fm);

    if (!zodParseResult.success) {
      for (const zi of zodParseResult.error.issues ?? []) {
        const pathStr = zi.path?.join(".") ?? "";
        const message = pathStr ? `${pathStr}: ${zi.message}` : zi.message;

        const errPayload: {
          code: string;
          path: PropertyKey[];
          expected?: unknown;
          received?: unknown;
        } = { code: zi.code, path: zi.path };

        if (zi.code === "invalid_type") {
          const maybe = zi as {
            code: "invalid_type";
            expected?: unknown;
            received?: unknown;
          };
          if ("expected" in maybe) errPayload.expected = maybe.expected;
          if ("received" in maybe) errPayload.received = maybe.received;
        }

        const issueBase: Issue<Provenance> = {
          kind: "frontmatter-parse",
          provenance: nb.provenance,
          disposition: "error",
          message,
          raw: nb.fm,
          error: errPayload,
        };

        // Cast to I so callers who extend Issue can still store their shape.
        nb.issues.push(issueBase as unknown as I);
      }
    }

    yield { notebook: nb, zodParseResult };
  }
}

/**
 * Enrich each documented code cell via callback; mutate in place; register
 * issues. Supports custom issue shape `I` on the target notebook (extends
 * base Issue).
 */
export async function* mutatePlaybookCodeCells<
  Provenance,
  FM extends Record<string, unknown>,
  Attrs extends Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  callback: (
    cell: PlaybookCodeCell<Provenance, Attrs>,
    ctx: {
      pb: Playbook<Provenance, FM, Attrs, I>;
      cellIndex: number;
      registerIssue: (issue: I) => void;
    },
  ) => void | Promise<void>,
  input: Asyncish<Playbook<Provenance, FM, Attrs, I>>,
) {
  for await (const nb of toAsync(input)) {
    const registerIssue = (issue: I) => nb.notebook.issues.push(issue);

    for (let i = 0; i < nb.cells.length; i++) {
      const c = nb.cells[i];
      if (c.kind !== "code") continue;
      await callback(c, { pb: nb, cellIndex: i, registerIssue });
    }

    yield nb;
  }
}

export type PlaybookCodeCellMutator<Provenance> = Parameters<
  typeof mutatePlaybookCodeCells<
    Provenance,
    Record<string, unknown>,
    Record<string, unknown>
  >
>[0];

/**
 * Create a mutator from a list of mutators
 * @param mutators the iteratable of mutators
 * @returns a single mutator which loops through the list
 */
export function pipedPlaybookCodeCellMutators<Provenance>(
  mutators: Iterable<PlaybookCodeCellMutator<Provenance>>,
): PlaybookCodeCellMutator<Provenance> {
  return async (cell, ctx) => {
    for await (const e of mutators) {
      e(cell, ctx);
    }
  };
}
