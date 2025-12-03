/**
 * Playbook projection for Spry.
 *
 * This module:
 * - Reads one or more Markdown sources via `markdownASTs`.
 * - Walks the mdast trees to find:
 *   - *Spawnable* code cells (turned into `Runnable` / `RunnableTask`).
 *   - `PARTIAL` code directives (turned into typed content fragments / partials).
 * - Resolves task dependencies, including implicit “injected” dependencies.
 * - Returns a `PlaybookProjection<FragmentLocals>` that other layers
 *   (CLI, interpolator, executor) can work with.
 *
 * Key ideas:
 * - **Runnable**: a code cell that can be executed (e.g. shell task).
 * - **Storable**: a code cell that can be stored but not executed (e.g. SQL without a connection task, HTML, JS, CSS, etc.).
 * - **RunnableTask**: a `Runnable` plus `taskId` and `taskDeps` helpers.
 * - **Directive**: a “meta” code cell that defines behavior/config
 *   (for example, `PARTIAL` fragments).
 * - **PartialCollection**: a registry of named partials/fragments, each with:
 *   - `identity` (name),
 *   - `content(locals)` render function with optional Zod validation,
 *   - optional injection metadata (glob-based wrapper behavior).
 */

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
  isStorableCodeCandidate,
  StorableCodeCandidate,
} from "../remark/spawnable-code-candidates.ts";
import { collectDirectives, Directive } from "./directives.ts";

/**
 * A *runnable* is a spawnable code cell:
 * - It has an identified language/engine (shell, deno-task, etc.).
 * - It carries arguments / flags parsed from the fence.
 * - It is associated with a Markdown origin (`provenance`).
 */
export type Runnable =
  & Omit<ExecutableCodeCandidate, "isSpawnableCodeCandidate">
  & { readonly provenance: MarkdownEncountered };

/**
 * A *storable* is a spawnable code cell:
 * - It has an identified language/engine (sql, yaml, etc.).
 * - It carries arguments / flags parsed from the fence along with attributes.
 * - It is associated with a Markdown origin (`provenance`).
 */
export type Storable =
  & Omit<StorableCodeCandidate, "isSpawnableCodeCandidate">
  & { readonly provenance: MarkdownEncountered };

/**
 * A runnable task is a `Runnable` with the two methods expected by the
 * generic task executor (`lib/universal/task.ts`):
 *
 * - `taskId()`  → unique ID for the task.
 * - `taskDeps()` → list of other task IDs that must run before this one.
 */
export type RunnableTask = Runnable & {
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
  readonly runnablesById: Record<string, Runnable>;
  readonly runnables: readonly Runnable[];
  readonly storablesById: Record<string, Storable>;
  readonly storables: readonly Storable[];
  readonly tasks: readonly RunnableTask[];
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
 *    - If `isSpawnableCodeCandidate(code)`, create a `Runnable`.
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
    readonly filter?: (task: Runnable) => boolean;
    readonly onDuplicateRunnable?: (
      r: Runnable,
      byIdentity: Record<string, Runnable>,
    ) => void;
    readonly onDuplicateStorable?: (
      r: Storable,
      byIdentity: Record<string, Storable>,
    ) => void;
    readonly encountered?: (projectable: MarkdownEncountered) => void;
  },
): Promise<PlaybookProjection<FragmentLocals>> {
  const { onDuplicateRunnable, onDuplicateStorable, encountered, filter } =
    init ?? {};
  const sources: MarkdownEncountered[] = [];
  const directives: Directive[] = [];
  const partials = partialsCollection<FragmentLocals>();
  const runnablesById: Record<string, Runnable> = {};
  const runnables: Runnable[] = [];
  const storablesById: Record<string, Storable> = {};
  const storables: Storable[] = [];

  // Discover all runnables and directives across all Markdown sources.
  for await (const src of markdownASTs(markdownPaths)) {
    sources.push(src);
    encountered?.(src);

    visit(src.mdastRoot, "code", (code) => {
      if (isExecutableCodeCandidate(code)) {
        const { isSpawnableCodeCandidate: _, ...executable } = code;
        const runnable: Runnable = { ...executable, provenance: src };

        if (!filter || filter(runnable)) {
          // `spawnable` is a shallow clone of `code`; we attach provenance.
          runnables.push(runnable);

          if (executable.spawnableIdentity in runnablesById) {
            // Caller decides what to do with duplicates (warn, override, etc.).
            onDuplicateRunnable?.(runnable, runnablesById);
          } else {
            runnablesById[executable.spawnableIdentity] = runnable;
          }
        }
      } else if (isStorableCodeCandidate(code)) {
        const { isSpawnableCodeCandidate: _, ...rest } = code;
        const storable: Storable = { ...rest, provenance: src };

        // `spawnable` is a shallow clone of `code`; we attach provenance.
        storables.push(storable);

        if (rest.storableIdentity in storablesById) {
          // Caller decides what to do with duplicates (warn, override, etc.).
          onDuplicateStorable?.(storable, storablesById);
        } else {
          storablesById[rest.storableIdentity] = storable;
        }
      }
    });

    collectDirectives(src, directives, partials);
  }

  // Resolve dependencies across all runnables.
  // - `depsResolver` knows how to compute transitive deps + injected deps.
  const dr = runnableDepsResolver(runnables);

  const tasks: RunnableTask[] = runnables.map((o) => ({
    ...o,
    taskId: () => o.spawnableIdentity, // satisfies Task interface
    taskDeps: () => dr.deps(o.spawnableIdentity, o.spawnableArgs.deps), // satisfies Task interface
  }));

  return {
    sources,
    runnables,
    runnablesById,
    storables,
    storablesById,
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
  catalog: Iterable<Runnable>,
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
      r: Runnable,
      source: string,
      error: unknown,
      compiledList: RegExp[],
    ) => void;
  },
) {
  const { onInvalidInjectedDepRegEx } = init ?? {};

  // `dataBag` attaches cached data to nodes without changing their public type.
  // Here we store a compiled list of regexes for each task’s injected-dep flags.
  const injectedDepCache = dataBag<"injectedDepCache", RegExp[], Runnable>(
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
