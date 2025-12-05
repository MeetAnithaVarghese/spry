/**
 * Playbook projection for Spry.
 *
 * This module:
 * - Reads one or more Markdown sources via `markdownASTs`.
 * - Walks the mdast trees to find:
 *   - *Actionable* code cells (turned into `Executable` / `ExecutableTask`).
 *   - `PARTIAL` code directives (turned into typed content fragments / partials).
 * - Resolves task dependencies, including implicit “injected” dependencies.
 * - Returns a `PlaybookProjection<FragmentLocals>` that other layers
 *   (CLI, interpolator, executor) can work with.
 *
 * Key ideas:
 * - **Runnable**: a code cell that can be executed (e.g. shell task).
 * - **Materializable**: a code cell that can be stored but not executed (e.g. SQL without a connection task, HTML, JS, CSS, etc.).
 * - **ExecutableTask**: a `Runnable` plus `taskId` and `taskDeps` helpers.
 * - **Directive**: a “meta” code cell that defines behavior/config
 *   (for example, `PARTIAL` fragments).
 * - **PartialCollection**: a registry of named partials/fragments, each with:
 *   - `identity` (name),
 *   - `content(locals)` render function with optional Zod validation,
 *   - optional injection metadata (glob-based wrapper behavior).
 */

import { Node } from "types/mdast";
import { visit } from "unist-util-visit";
import {
  PartialCollection,
  partialContentCollection as partialsCollection,
} from "../../interpolate/partial.ts";
import { depsResolver } from "../../universal/depends.ts";
import { markdownASTs, MarkdownEncountered } from "../io/mod.ts";
import { dataBag } from "../mdast/data-bag.ts";
import {
  ExecutableCodeCandidate,
  isExecutableCodeCandidate,
  isMateriazableCodeCandidate,
  MaterializableCodeCandidate,
} from "../remark/actionable-code-candidates.ts";
import { collectDirectives, Directive } from "./directives.ts";

/**
 * A *executable* is an actionable code cell:
 * - It has an identified language/engine (shell, deno-task, etc.).
 * - It carries arguments / flags parsed from the fence.
 * - It is associated with a Markdown origin (`provenance`).
 */
export type Executable =
  & Omit<ExecutableCodeCandidate, "isActionableCodeCandidate">
  & { readonly provenance: MarkdownEncountered };

/**
 * A *materializable* is a actionable code cell:
 * - It has an identified language/engine (sql, yaml, etc.).
 * - It carries arguments / flags parsed from the fence along with attributes.
 * - It is associated with a Markdown origin (`provenance`).
 */
export type Materializable =
  & Omit<MaterializableCodeCandidate, "isActionableCodeCandidate">
  & { readonly provenance: MarkdownEncountered };

export function isMaterializable(
  node: Node | null | undefined,
): node is Materializable {
  return node?.type === "code" && "nature" in node &&
      node.nature === "MATERIALIZABLE"
    ? true
    : false;
}

/**
 * A runnable task is a `Runnable` with the two methods expected by the
 * generic task executor (`lib/universal/task.ts`):
 *
 * - `taskId()`  → unique ID for the task.
 * - `taskDeps()` → list of other task IDs that must run before this one.
 */
export type ExecutableTask = Executable & {
  readonly taskId: () => string; // satisfies lib/universal/task.ts interface
  readonly taskDeps: () => string[]; // satisfies lib/universal/task.ts interface
};

/**
 * PlaybookProjection represents everything we discovered across Markdown files:
 *
 * - `runnablesById` – lookup table of runnable code cells by identity.
 * - `runnables`     – all runnable code cells in input order.
 * - `storablesById` – lookup table of storable code cells by identity.
 * - `storables`     – all storable code cells in input order.
 * - `tasks`         – runnables decorated with `taskId` / `taskDeps`.
 * - `directives`    – directive cells (e.g. PARTIAL definitions).
 * - `partials`      – typed collection of partials / fragments that
 *                     can be used by interpolators (`FragmentLocals` is
 *                     the shape of locals passed when rendering a partial).
 */
export type PlaybookProjection<
  FragmentLocals extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly sources: readonly MarkdownEncountered[];
  readonly executablesById: Record<string, Executable>;
  readonly executables: readonly Executable[];
  readonly materializablesById: Record<string, Materializable>;
  readonly materializables: readonly Materializable[];
  readonly tasks: readonly ExecutableTask[];
  readonly directives: readonly Directive[];
  readonly partials: PartialCollection<FragmentLocals>;
};

/**
 * Load one or more Markdown files/remotes and build a `RunbookProjection`.
 *
 * Steps:
 * 1. Stream all Markdown inputs via `markdownASTs(markdownPaths)`.
 * 2. For each mdast root:
 *    - Visit `code` nodes.
 *    - If `isActionableCodeCandidate(code)`, create a `Runnable`.
 *    - If `isCodeDirectiveCandidate(code)`, create a `Directive`.
 * 3. After scanning everything:
 *    - Build a `RunnableTask` list with dependency resolution.
 *    - Build a `PartialCollection<FragmentLocals>` from `PARTIAL` directives.
 *
 * @template FragmentLocals
 *   The locals type each partial expects at render time
 *   (e.g. `{ user: string; env: string }`).
 *
 * @param markdownPaths
 *   A path/glob/URL or array accepted by `markdownASTs`.
 * @param init
 *   Optional hooks:
 *   - `filter`: skip runnables that do not match a predicate.
 *   - `onDuplicateRunnable`: callback when two runnables share the same identity.
 *   - `encountered`: callback for each Markdown source as it is parsed.
 */
export async function playbooksFromFiles<
  FragmentLocals extends Record<string, unknown> = Record<string, unknown>,
>(
  markdownPaths: Parameters<typeof markdownASTs>[0],
  init?: {
    readonly filter?: (task: Executable) => boolean;
    readonly onDuplicateRunnable?: (
      r: Executable,
      byIdentity: Record<string, Executable>,
    ) => void;
    readonly onDuplicateStorable?: (
      r: Materializable,
      byIdentity: Record<string, Materializable>,
    ) => void;
    readonly encountered?: (projectable: MarkdownEncountered) => void;
  },
): Promise<PlaybookProjection<FragmentLocals>> {
  const { onDuplicateRunnable, onDuplicateStorable, encountered, filter } =
    init ?? {};
  const sources: MarkdownEncountered[] = [];
  const directives: Directive[] = [];
  const partials = partialsCollection<FragmentLocals>();
  const executablesById: Record<string, Executable> = {};
  const executables: Executable[] = [];
  const materializablesById: Record<string, Materializable> = {};
  const materializables: Materializable[] = [];

  // Discover all runnables and directives across all Markdown sources.
  for await (const src of markdownASTs(markdownPaths)) {
    sources.push(src);
    encountered?.(src);

    visit(src.mdastRoot, "code", (code) => {
      if (isExecutableCodeCandidate(code)) {
        const { isActionableCodeCandidate: _, ...executable } = code;
        const runnable: Executable = { ...executable, provenance: src };

        if (!filter || filter(runnable)) {
          executables.push(runnable);

          if (executable.spawnableIdentity in executablesById) {
            // Caller decides what to do with duplicates (warn, override, etc.).
            onDuplicateRunnable?.(runnable, executablesById);
          } else {
            executablesById[executable.spawnableIdentity] = runnable;
          }
        }
      } else if (isMateriazableCodeCandidate(code)) {
        const { isActionableCodeCandidate: _, ...rest } = code;
        const storable: Materializable = { ...rest, provenance: src };

        // `spawnable` is a shallow clone of `code`; we attach provenance.
        materializables.push(storable);

        if (rest.materializableIdentity in materializablesById) {
          // Caller decides what to do with duplicates (warn, override, etc.).
          onDuplicateStorable?.(storable, materializablesById);
        } else {
          materializablesById[rest.materializableIdentity] = storable;
        }
      }
    });

    collectDirectives(src, directives, partials);
  }

  // Resolve dependencies across all runnables.
  // - `depsResolver` knows how to compute transitive deps + injected deps.
  const dr = runnableDepsResolver(executables);

  const tasks: ExecutableTask[] = executables.map((o) => ({
    ...o,
    taskId: () => o.spawnableIdentity, // satisfies Task interface
    taskDeps: () => dr.deps(o.spawnableIdentity, o.spawnableArgs.deps), // satisfies Task interface
  }));

  return {
    sources,
    executables,
    executablesById,
    materializables,
    materializablesById,
    tasks,
    directives,
    partials,
  };
}

/**
 * Helper: build a dependency resolver for `Runnable` tasks.
 *
 * This uses the generic `depsResolver` from `universal/depends.ts`, and
 * extends it with support for *implicit* injected dependencies:
 *
 * - Tasks may declare `--injected-dep` flags (e.g. in code fence PI).
 * - These are treated as regex patterns that match other task IDs.
 * - When a task is the *target* of an injected-dep pattern, the
 *   *source* task is added as an implicit dependency.
 *
 * The result is an object whose `deps(taskId, explicitDeps)` call returns
 * a combined list of:
 * - explicit dependencies (from the task’s own args), plus
 * - implicit injected dependencies (from other tasks’ flags).
 */
export function runnableDepsResolver(
  catalog: Iterable<Executable>,
  init?: {
    /**
     * Optional hook invoked when a `--injected-dep` pattern cannot be compiled
     * as a regular expression. We pass:
     * - the task `r`,
     * - the bad `source` string,
     * - the thrown `error`,
     * - and the `compiledList` built so far.
     *
     * The callback is responsible for logging or collecting the error.
     */
    onInvalidInjectedDepRegEx?: (
      r: Executable,
      source: string,
      error: unknown,
      compiledList: RegExp[],
    ) => void;
  },
) {
  const { onInvalidInjectedDepRegEx } = init ?? {};

  // `dataBag` attaches cached data to nodes without changing their public type.
  // Here we store a compiled list of regexes for each task’s injected-dep flags.
  const injectedDepCache = dataBag<"injectedDepCache", RegExp[], Executable>(
    "injectedDepCache",
    (r) => {
      const compiledList: RegExp[] = [];

      for (const expr of r.spawnableArgs.injectedDep) {
        // Special case: "*" means "match everything" → /.*/
        const source = expr === "*" ? ".*" : expr;

        try {
          compiledList.push(new RegExp(source));
        } catch (error) {
          // Record invalid regex source but do not throw.
          onInvalidInjectedDepRegEx?.(r, source, error, compiledList);
          // Skip adding this invalid pattern.
        }
      }

      return compiledList;
    },
  );

  return depsResolver(catalog, {
    // This tells depsResolver how to identify each node.
    getId: (node) => node.spawnableIdentity,

    /**
     * Compute implicit dependencies for a given task:
     *
     * - For each *other* task that declares `--injected-dep`, compile its
     *   patterns (once) and see whether any match `node.identity`.
     * - If yes, that task’s ID is added to `injected[]` (unless it’s already
     *   present or not in the global catalog).
     *
     * The returned string[] is merged with explicit deps by depsResolver.
     */
    getImplicit: (node) => {
      const injected: string[] = [];

      const tasks = Array.from(catalog).map((n) => n.spawnableIdentity);

      for (const task of catalog) {
        const taskId = task.spawnableIdentity;
        const di = task.spawnableArgs.injectedDep;
        if (di.length === 0) continue;

        if (injectedDepCache.is(task)) {
          // Check whether ANY of the compiled regexes matches the requested taskId.
          let matches = false;
          for (const re of task.data.injectedDepCache) {
            if (
              re instanceof RegExp && re.test(node.spawnableIdentity)
            ) {
              matches = true;
              break;
            }
          }
          if (!matches) continue;
        }

        // Skip tasks that are not in the catalog or already injected.
        if (!tasks.includes(taskId) && !injected.includes(taskId)) {
          injected.push(taskId);
        }
      }

      return injected.length ? injected : undefined;
    },
  });
}
