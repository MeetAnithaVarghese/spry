/**
 * Unified plugin for discovering **spawnable** code blocks in Markdown.
 *
 * What this module does
 * ---------------------
 * - Walks an MDAST `Root` and inspects `code` nodes.
 * - When it finds a code block that:
 *   - is not already a code directive (`isCodeDirectiveCandidate`), and
 *   - matches the `isCandidate` predicate (by default, a supported language),
 *   and
 *   - has PI-style meta frontmatter with a positional identity,
 *   it annotates that node as a **SpawnableCodeCandidate**.
 *
 * These spawnable nodes are still just MDAST `code` nodes; this plugin does
 * **not** execute them. It only enriches them with enough metadata for later
 * stages to either:
 *   - run them as *executable* cells (e.g., a runbook engine), or
 *   - persist them as *storable* templates (e.g., SQLPage snippets, browser
 *     assets, env files) to be executed by some external system.
 *
 * EXECUTABLE vs STORABLE
 * ----------------------
 * After parsing the PI flags and language information, each candidate is
 * classified into one of two natures:
 *
 * - `nature: "EXECUTABLE"`
 *   - A code cell that a Spry-style runner could execute directly (e.g. `shell`
 *     commands).
 *   - The plugin fills:
 *       - `spawnableIdentity`: name/handle for the task.
 *       - `language`: concrete `LanguageSpec` resolved from the registry.
 *       - `spawnableArgs`: parsed `codeSpawnablePiFlagsSchema`.
 *   - Conceptually, **interpolation is off by default** for this class of code
 *     in the runbook / process-execution world. The plugin itself just parses
 *     the `interpolate` flag; if it remains `undefined`, downstream executors
 *     should treat that as “do not interpolate unless explicitly requested.”
 *
 * - `nature: "STORABLE"`
 *   - A code block that is *not* run as part of the current runbook; instead,
 *     it is treated as content to store (filesystem, DB, config registry, etc.)
 *     for later use by another system, such as SQLPage or a web browser.
 *   - This includes:
 *       - Env-style snippets (`env`, `envrc`) that are only captured and not
 *         executed.
 *       - Any other language that you choose to treat as “capture only”.
 *   - The plugin fills:
 *       - `storableIdentity`: storage key / name for the snippet.
 *       - `language`: optional `LanguageSpec` (may be omitted if not needed).
 *       - `storableArgs`: parsed `codeSpawnablePiFlagsSchema`.
 *       - `storableAttrs`: arbitrary attrs from the code frontmatter.
 *   - Conceptually, **interpolation is on by default** for this class of code
 *     in the “storable asset” world. The plugin again only parses the flag;
 *     if `interpolate` is `undefined`, downstream emitters/loaders should treat
 *     that as “interpolate by default when materializing this snippet.”
 *
 * Interpolation and capture
 * -------------------------
 * All spawnable / storable code shares a common PI flags schema
 * (`codeSpawnablePiFlagsSchema`) which includes:
 *
 * - `interpolate` / `I`:
 *   - Parsed as a raw boolean; the module does not force a default.
 *   - Downstream behavior:
 *     - For **EXECUTABLE** tasks: default should be “no interpolation unless
 *       explicitly set”.
 *     - For **STORABLE** snippets: default should be “interpolate unless
 *       explicitly turned off”.
 * - `capture` / `C`:
 *   - One or more capture targets, which are normalized into `CaptureSpec`:
 *       - If a value starts with `"./"` it is treated as a relative filesystem
 *         path (`nature: "relFsPath"`) with optional `gitignore`.
 *       - Otherwise it is treated as an in-memory capture key
 *         (`nature: "memory"`).
 *   - `captureOnly`:
 *       - When true, indicates that the code should not actually be executed,
 *         only interpolated and captured.
 *       - For some languages (see `captureOnlyLangIds`), this effectively
 *         makes the node `nature: "STORABLE"` even though it is still a `code`
 *         block in the Markdown.
 *
 * Language selection and classification
 * -------------------------------------
 * By default, the plugin considers only a fixed set of “spawnable” languages:
 *
 * - `spawnableLangIds`: base language IDs (e.g. `"shell"`, `"envrc"`, `"env"`).
 * - `spawnableLangSpecs`: their corresponding `LanguageSpec` entries from
 *   `languageRegistry`.
 * - `captureOnlyLangIds`: a subset of those whose code is never “run” but
 *   only **captured** (e.g. `"env"`, `"envrc"`); these are always treated as
 *   `nature: "STORABLE"` and not as executable tasks.
 *
 * The candidate predicate:
 * - `isCandidate` (in `SpawnableCodeCandidatesOptions`) can override the
 *   default language-based selection.
 * - If omitted, only code blocks whose `lang` matches any `spawnableLangSpecs`
 *   (by id or alias) are inspected further.
 *
 * How the plugin operates (step-by-step)
 * --------------------------------------
 * 1. Unified’s `visit` walks all `code` nodes in the MDAST `Root`.
 * 2. For each `code` node:
 *    - Skip if it is already a directive (`isCodeDirectiveCandidate`).
 *    - Skip if `isCandidate(code)` returns false.
 *    - If `code.meta` exists, parse it via `codeFrontmatter(code)` to extract:
 *        - `langSpec`: resolved `LanguageSpec`.
 *        - `pi`: positional and flag arguments for the PI.
 *        - `attrs`: any additional attributes.
 *    - If there is at least one positional PI argument (`pi.posCount > 0`):
 *        a. Parse PI flags with `codeSpawnablePiFlagsSchema`.
 *        b. On success:
 *           - Determine `nature`:
 *               - If the language id is in `captureOnlyLangIds`, set
 *                 `nature: "STORABLE"`.
 *               - Otherwise, set `nature: "EXECUTABLE"`.
 *           - Cast the node to `SpawnableCodeCandidate` and attach:
 *               - `isSpawnableCodeCandidate = true`.
 *               - For EXECUTABLE:
 *                   - `spawnableIdentity`, `language`, `spawnableArgs`.
 *               - For STORABLE:
 *                   - `storableIdentity`, `language`, `storableArgs`,
 *                     `storableAttrs`.
 *           - Sanity-check with `isSpawnableCodeCandidate`; if that fails,
 *             attach an error via `addIssue`.
 *        c. On parse failure:
 *           - Attach an error issue to the node (`"Unable to parse PI flags"`).
 *
 * At the end of this pass, consumers can:
 * - Use `isSpawnableCodeCandidate`, `isExecutableCodeCandidate`, and
 *   `isStorableCodeCandidate` to find annotated code nodes.
 * - Respect the conceptual defaults for `interpolate` based on `nature`.
 * - Execute EXECUTABLE nodes or persist STORABLE nodes in a filesystem or
 *   database for later use by systems like SQLPage or a browser.
 */
import z from "@zod/zod";
import type { Code, Root } from "types/mdast";
import type { Node } from "types/unist";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { CaptureSpec } from "../../interpolate/capture.ts";
import { languageRegistry, languageSpecSchema } from "../../universal/code.ts";
import {
  flexibleTextSchema,
  mergeFlexibleText,
} from "../../universal/posix-pi.ts";
import { codeFrontmatter } from "../mdast/code-frontmatter.ts";
import { addIssue } from "../mdast/node-issues.ts";
import { isCodeDirectiveCandidate } from "./code-directive-candidates.ts";
import { isCodeImport } from "./import-specs-resolver.ts";

export const codeSpawnablePiFlagsSchema = z.object({
  descr: z.string().optional(),
  dep: flexibleTextSchema.optional(), // collected as multiple --dep
  capture: flexibleTextSchema.optional(),
  interpolate: z.boolean().optional(),
  silent: z.boolean().optional(),
  gitignore: z.union([z.string(), z.boolean()]).optional(),
  graph: flexibleTextSchema.optional(),
  branch: flexibleTextSchema.optional(),
  injectedDep: flexibleTextSchema.optional(),

  // shortcuts
  /* capture */ C: z.string().optional(),
  /* branch/graph */ B: flexibleTextSchema.optional(),
  /* dep */ D: flexibleTextSchema.optional(),
  /* graph/branch */ G: flexibleTextSchema.optional(),
  /* interpolate */ I: z.boolean().optional(),
}).transform((raw) => {
  const depRaw = mergeFlexibleText(raw.D, raw.dep);
  const graphRaw = mergeFlexibleText(raw.G, raw.graph);
  const capture = mergeFlexibleText(raw.C, raw.capture);
  const injectedDep = mergeFlexibleText(raw.injectedDep);
  return {
    description: raw.descr,
    deps: depRaw ? typeof depRaw === "string" ? [depRaw] : depRaw : undefined,
    capture: capture.map((c) =>
      (c.startsWith("./")
        ? { nature: "relFsPath", fsPath: c, gitignore: raw.gitignore }
        : { nature: "memory", key: c }) satisfies CaptureSpec
    ),
    interpolate: raw.I ?? raw.interpolate,
    graphs: graphRaw
      ? typeof graphRaw === "string" ? [graphRaw] : graphRaw
      : undefined,
    silent: raw.silent,
    injectedDep,
  };
});

export type CodeSpawnablePiFlags = z.infer<typeof codeSpawnablePiFlagsSchema>;

export const codeSpawnableSchema = z.discriminatedUnion("nature", [
  z.object({
    nature: z.literal("EXECUTABLE"),
    captureOnly: z.boolean().optional(), // don't execute, just capture interpolation results
    spawnableIdentity: z.string().min(1), // required, names the task
    language: languageSpecSchema,
    spawnableArgs: codeSpawnablePiFlagsSchema, // typed, parsed, validated
  }).strict(),
  z.object({
    nature: z.literal("STORABLE"),
    storableIdentity: z.string().min(1), // required, names the task
    language: languageSpecSchema.optional(),
    storableArgs: codeSpawnablePiFlagsSchema, // typed, parsed, validated
    storableAttrs: z.custom<Record<string, unknown>>().optional(),
  }).strict(),
]);

export type SpawnableCodeCandidate =
  & Code
  & { isSpawnableCodeCandidate: true }
  & z.infer<typeof codeSpawnableSchema>;

export type ExecutableCodeCandidate = Extract<
  SpawnableCodeCandidate,
  { nature: "EXECUTABLE" }
>;

export type StorableCodeCandidate = Extract<
  SpawnableCodeCandidate,
  { nature: "STORABLE" }
>;

export function isSpawnableCodeCandidate(
  node: Node | null | undefined,
): node is SpawnableCodeCandidate {
  return node?.type === "code" && "isSpawnableCodeCandidate" in node &&
      node.isSpawnableCodeCandidate
    ? true
    : false;
}

export function isExecutableCodeCandidate(
  node: Node | null | undefined,
): node is ExecutableCodeCandidate {
  return isSpawnableCodeCandidate(node) && node.nature === "EXECUTABLE"
    ? true
    : false;
}

export function isStorableCodeCandidate(
  node: Node | null | undefined,
): node is StorableCodeCandidate {
  return isSpawnableCodeCandidate(node) && node.nature === "STORABLE"
    ? true
    : false;
}

export const spawnableLangIds = ["shell", "envrc", "env"] as const;
export const captureOnlySpawnableLangIds = ["envrc", "env"] as const; // these are not "run", just "captured"
export type SpawnableLangIds = typeof spawnableLangIds[number];
export const spawnableLangSpecs = spawnableLangIds.map((lid) => {
  const langSpec = languageRegistry.get(lid);
  if (!langSpec) throw new Error("this should never happen");
  return langSpec;
});
export const captureOnlySpawnableLangSpecs = captureOnlySpawnableLangIds.map(
  (lid) => {
    const langSpec = languageRegistry.get(lid);
    if (!langSpec) throw new Error("this should never happen");
    return langSpec;
  },
);

// deno-lint-ignore no-empty-interface
export interface SpawnableCodeCandidatesOptions {
}

export const spawnableCodeCandidates: Plugin<
  [SpawnableCodeCandidatesOptions?],
  Root
> = () => {
  return (tree) => {
    visit<Root, "code">(tree, "code", (code) => {
      if (isCodeDirectiveCandidate(code) || isCodeImport(code)) return;

      if (code.meta) {
        const codeFM = codeFrontmatter(code);
        if (codeFM?.langSpec && codeFM?.pi.posCount) {
          const args = z.safeParse(
            codeSpawnablePiFlagsSchema,
            codeFM.pi.flags,
          );
          if (args.success) {
            const identity = codeFM.pi.pos[0];
            const nature: SpawnableCodeCandidate["nature"] =
              spawnableLangSpecs.find((l) => l.id == codeFM.langSpec?.id)
                ? "EXECUTABLE" as const
                : "STORABLE" as const;

            const spawnable = code as SpawnableCodeCandidate;
            spawnable.nature = nature;
            spawnable.isSpawnableCodeCandidate = true;

            switch (spawnable.nature) {
              case "EXECUTABLE": {
                spawnable.nature = "EXECUTABLE";
                spawnable.spawnableIdentity = identity;
                spawnable.language = codeFM.langSpec;
                spawnable.spawnableArgs = args.data;
                spawnable.captureOnly = captureOnlySpawnableLangSpecs.find(
                    (l) => l.id == codeFM.langSpec?.id,
                  )
                  ? true
                  : false;
                break;
              }

              case "STORABLE": {
                spawnable.nature = "STORABLE";
                spawnable.storableIdentity = identity;
                spawnable.language = codeFM.langSpec;
                spawnable.storableArgs = args.data;
                spawnable.storableAttrs = codeFM.attrs;
              }
            }

            if (!isSpawnableCodeCandidate(code)) {
              addIssue(code, {
                severity: "error",
                message: "Code should be a spawnable candidate now",
                error: new Error("Code should be a spawnable candidate now", {
                  cause: codeFM,
                }),
              });
            }
          } else {
            addIssue(code, {
              severity: "error",
              message: "Unable to parse PI flags",
              error: args.error,
            });
          }
        }
      }
    });
  };
};

export default spawnableCodeCandidates;
