/**
 * Runbook projection for Spry.
 *
 * This module:
 * - Reads one or more Markdown sources via `markdownASTs`.
 * - Walks the mdast trees to find:
 *   - *Spawnable* code cells (turned into `Runnable` / `RunnableTask`).
 *   - `PARTIAL` code directives (turned into typed content fragments / partials).
 * - Resolves task dependencies, including implicit “injected” dependencies.
 * - Returns a `RunbookProjection<FragmentLocals>` that other layers
 *   (CLI, interpolator, executor) can work with.
 *
 * Key ideas:
 * - **Runnable**: a code cell that can be executed (e.g. shell task).
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
  partialContent,
  partialContentCollection as partialsCollection,
} from "../../interpolate/partial.ts";
import { depsResolver } from "../../universal/depends.ts";
import { markdownASTs, MarkdownEncountered } from "../io/mod.ts";
import { dataBag } from "../mdast/data-bag.ts";
import {
  CodeDirectiveCandidate,
  isCodeDirectiveCandidate,
} from "../remark/code-directive-candidates.ts";
import {
  isSpawnableCodeCandidate,
  SpawnableCodeCandidate,
} from "../remark/spawnable-code-candidates.ts";

/**
 * A directive is a code cell that controls behavior instead of being executed.
 *
 * Example: a fenced block like
 *
 * ```md
 * ```sql PARTIAL footer
 * -- footer here
 * ```
 *
 * is parsed as a `CodeDirectiveCandidate`, and we wrap it as a `Directive`
 * with an added `provenance` (where it came from in which Markdown file).
 */
export type Directive =
  & Omit<CodeDirectiveCandidate<string, string>, "isCodeDirectiveCandidate">
  & { readonly provenance: MarkdownEncountered };

/**
 * A *runnable* is a spawnable code cell:
 * - It has an identified language/engine (shell, deno-task, etc.).
 * - It carries arguments / flags parsed from the fence.
 * - It is associated with a Markdown origin (`provenance`).
 */
export type Runnable =
  & Omit<SpawnableCodeCandidate, "isSpawnableCodeCandidate">
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
 * RunbookProjection represents everything we discovered across Markdown files:
 *
 * - `runnablesById` – lookup table of runnable code cells by identity.
 * - `runnables`     – all runnable code cells in input order.
 * - `tasks`         – runnables decorated with `taskId` / `taskDeps`.
 * - `directives`    – directive cells (e.g. PARTIAL definitions).
 * - `partials`      – typed collection of partials / fragments that
 *                     can be used by interpolators (`FragmentLocals` is
 *                     the shape of locals passed when rendering a partial).
 */
export type RunbookProjection<
  FragmentLocals extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly runnablesById: Record<string, Runnable>;
  readonly runnables: readonly Runnable[];
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
export async function runbooksFromFiles<
  FragmentLocals extends Record<string, unknown> = Record<string, unknown>,
>(
  markdownPaths: Parameters<typeof markdownASTs>[0],
  init?: {
    readonly filter?: (task: Runnable) => boolean;
    readonly onDuplicateRunnable?: (
      r: Runnable,
      byIdentity: Record<string, Runnable>,
    ) => void;
    readonly encountered?: (projectable: MarkdownEncountered) => void;
  },
): Promise<RunbookProjection<FragmentLocals>> {
  const { onDuplicateRunnable, encountered, filter } = init ?? {};
  const directives: Directive[] = [];
  const runnablesById: Record<string, Runnable> = {};
  const runnables: Runnable[] = [];

  // Discover all runnables and directives across all Markdown sources.
  for await (const src of markdownASTs(markdownPaths)) {
    encountered?.(src);

    visit(src.mdastRoot, "code", (code) => {
      if (isSpawnableCodeCandidate(code)) {
        const { isSpawnableCodeCandidate: _, ...spawnable } = code;
        const runnable: Runnable = { ...spawnable, provenance: src };

        if (!filter || filter(runnable)) {
          // `spawnable` is a shallow clone of `code`; we attach provenance.
          runnables.push(runnable);

          if (spawnable.identity in runnablesById) {
            // Caller decides what to do with duplicates (warn, override, etc.).
            onDuplicateRunnable?.(runnable, runnablesById);
          } else {
            runnablesById[spawnable.identity] = runnable;
          }
        }
      } else if (isCodeDirectiveCandidate(code)) {
        const { isCodeDirectiveCandidate: _, ...rest } = code;
        directives.push({ ...rest, provenance: src });
      }
    });
  }

  // Resolve dependencies across all runnables.
  // - `depsResolver` knows how to compute transitive deps + injected deps.
  const dr = runnableDepsResolver(runnables);

  const tasks: RunnableTask[] = runnables.map((o) => ({
    ...o,
    taskId: () => o.identity, // satisfies Task interface
    taskDeps: () => dr.deps(o.identity, o.args.deps), // satisfies Task interface
  }));

  // Build the partials collection from all `PARTIAL` directives.
  const partials = partialsCollection<FragmentLocals>();

  for (const d of directives) {
    if (d.directive === "PARTIAL") {
      const { pi: { flags }, attrs } = d.instructions;

      const hasFlag = (k: string) =>
        k in flags && flags[k] !== false && flags[k] !== undefined;

      // `--inject` can be:
      //   - absent        → no injection
      //   - string        → single glob
      //   - string[]      → multiple globs
      const injectGlobs = flags.inject === undefined
        ? []
        : Array.isArray(flags.inject)
        ? (flags.inject as string[])
        : [String(flags.inject)];

      // Only build a spec when attrs are present
      const schemaSpec = attrs && Object.keys(attrs).length > 0
        ? attrs
        : undefined;

      // Always pass schemaSpec + strictArgs; inject is optional.
      partials.register(
        partialContent<FragmentLocals>(
          d.identity,
          d.value,
          {
            schemaSpec,
            strictArgs: true,
            inject: injectGlobs.length
              ? {
                globs: injectGlobs,
                prepend: hasFlag("prepend"),
                append: hasFlag("append"),
              }
              : undefined,
          },
        ),
      );
    }
  }

  return {
    runnables,
    runnablesById,
    tasks,
    directives,
    partials,
  } as RunbookProjection<FragmentLocals>;
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

      for (const expr of r.args.injectedDep) {
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
    getId: (node) => node.identity,

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

      const tasks = Array.from(catalog).map((n) => n.identity);

      for (const task of catalog) {
        const taskId = task.identity;
        const di = task.args.injectedDep;
        if (di.length === 0) continue;

        if (injectedDepCache.is(task)) {
          // Check whether ANY of the compiled regexes matches the requested taskId.
          let matches = false;
          for (const re of task.data.injectedDepCache) {
            if (
              re instanceof RegExp && re.test(node.identity)
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
