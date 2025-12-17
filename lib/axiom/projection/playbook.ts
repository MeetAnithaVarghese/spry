/**
 * Playbook projection for Spry.
 *
 * This module is the bridge between "physical" Markdown and the logical
 * playbook graph that the executor can operate on.
 *
 * Responsibilities:
 * - Load one or more Markdown sources via `markdownASTs`.
 * - Walk mdast trees to discover:
 *   - *Executable* code cells → `Executable` / `ExecutableTask`.
 *   - *Materializable* code cells → `Materializable`.
 *   - *Directive* code cells → `Directive` (behavior / config, not executed).
 * - Attach provenance (which Markdown file, which position) to each node.
 * - Resolve task dependencies, including implicit “injected” dependencies.
 * - Return a `PlaybookProjection` that other layers
 *   (CLI, interpolator, executor, UI) can work with.
 *
 * Key ideas:
 * - **Executable**:
 *   A spawnable code cell, usually intended to run (shell commands, deno, etc.).
 *   Carries a unique `spawnableIdentity` plus parsed fence args.
 *
 * - **Materializable**:
 *   A spawnable code cell whose primary purpose is to be *persisted*
 *   (e.g. SQL, HTML, YAML, JSON) rather than directly executed by Spry’s
 *   task runner. These can later be "emitted" into files, databases, etc.
 *
 * - **ExecutableTask**:
 *   An `Executable` decorated with `taskId()` and `taskDeps()` helpers so it
 *   conforms to the generic task graph interface in `universal/task.ts`.
 *
 * - **Directive**:
 *   A “meta” code cell that configures behavior instead of being executed.
 *   Example: `PARTIAL` fragments, render-time configuration, or other
 *   orchestration hints.
 *
 * Overall lifecycle:
 * - Markdown → mdast → actionable / directive candidates → `PlaybookProjection`.
 * - A later step (e.g. `tasksRunbook`) consumes `PlaybookProjection.tasks`
 *   to actually execute the DAG.
 */

import { Code, Node } from "types/mdast";
import { visit } from "unist-util-visit";
import { depsResolver } from "../../universal/depends.ts";
import { markdownASTs, MarkdownEncountered } from "../io/mod.ts";
import { dataBag } from "../mdast/data-bag.ts";
import { NodeIssue, nodeIssues } from "../mdast/node-issues.ts";
import {
  ExecutableCodeCandidate,
  isExecutableCodeCandidate,
  isMateriazableCodeCandidate,
  MaterializableCodeCandidate,
} from "../remark/actionable-code-candidates.ts";
import {
  CodeDirectiveCandidate,
  isCodeDirectiveCandidate,
} from "../remark/code-directive-candidates.ts";

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
 * with an added `provenance` (where it came from, in which Markdown file).
 */
export type Directive =
  & Omit<CodeDirectiveCandidate<string, string>, "isCodeDirectiveCandidate">
  & { readonly provenance: MarkdownEncountered };

/**
 * A *executable* is an actionable code cell:
 * - It has an identified language/engine (shell, deno-task, etc.).
 * - It carries arguments / flags parsed from the fence.
 * - It is associated with a Markdown origin (`provenance`).
 * - It is expected to participate in the task graph (via `ExecutableTask`).
 */
export type Executable =
  & Omit<ExecutableCodeCandidate, "isActionableCodeCandidate">
  & { readonly provenance: MarkdownEncountered; readonly origin: Code };

/**
 * A *materializable* is an actionable code cell whose primary purpose is
 * *emission* rather than *execution*:
 *
 * - It has an identified language/engine (sql, yaml, html, json, etc.).
 * - It carries arguments / flags parsed from the fence along with attributes.
 * - It is associated with a Markdown origin (`provenance`).
 * - It is usually turned into a stored artifact (file, DB row, etc.)
 *   by other layers instead of being run as a process.
 */
export type Materializable =
  & Omit<MaterializableCodeCandidate, "isActionableCodeCandidate">
  & { readonly provenance: MarkdownEncountered; readonly origin: Code };

/**
 * Type guard: check whether a node is a `Materializable` as produced by
 * `playbooksFromFiles`.
 *
 * This is intentionally narrow:
 * - The node must be a `code` node.
 * - The `nature` field must exist and equal `"MATERIALIZABLE"`.
 *
 * Note: this operates on the *projected* nodes, not raw mdast input.
 */
export function isMaterializable(
  node: Node | null | undefined,
): node is Materializable {
  return node?.type === "code" && "nature" in node &&
      node.nature === "MATERIALIZABLE"
    ? true
    : false;
}

/**
 * An executable task is a `Executable` with the two methods expected by the
 * generic task executor (`lib/universal/task.ts`):
 *
 * - `taskId()`   → unique ID for the task (usually `spawnableIdentity`).
 * - `taskDeps()` → list of other task IDs that must run before this one.
 *
 * The extra methods are *computed* views; they do not mutate the underlying
 * `Executable`. This keeps the projection immutable while still satisfying
 * the executor’s interface.
 */
export type ExecutableTask = Executable & {
  readonly taskId: () => string; // satisfies lib/universal/task.ts interface
  readonly taskDeps: () => string[]; // satisfies lib/universal/task.ts interface
};

/**
 * PlaybookProjection represents everything we discovered across Markdown files:
 *
 * - `sources`
 *   All Markdown sources encountered, in discovery order.
 *
 * - `executablesById`
 *   Lookup table of spawnable code cells by `spawnableIdentity`.
 *
 * - `executables`
 *   All spawnable code cells in input order. This preserves the "physical"
 *   order as found in Markdown, which can be useful for debugging and UIs.
 *
 * - `materializablesById`
 *   Lookup table of materializable code cells by `materializableIdentity`.
 *
 * - `materializables`
 *   All materializable code cells in input order.
 *
 * - `tasks`
 *   Executables decorated with `taskId` / `taskDeps`. This is what the
 *   task executor consumes.
 *
 * - `directives`
 *   Directive cells (e.g. PARTIAL definitions, behavior hints, etc.).
 *
 * - `issues`
 *   Any code nodes that produced "issues" (warnings/errors) as reported by
 *   `nodeIssues`. Each entry includes provenance for better diagnostics.
 */
export type PlaybookProjection = {
  readonly sources: readonly MarkdownEncountered[];
  readonly executablesById: Record<string, Executable>;
  readonly executables: readonly Executable[];
  readonly materializablesById: Record<string, Materializable>;
  readonly materializables: readonly Materializable[];
  readonly tasks: readonly ExecutableTask[];
  readonly directives: readonly Directive[];
  readonly issues: readonly (Code & {
    readonly data: { readonly issues: NodeIssue[] };
    readonly provenance: MarkdownEncountered;
  })[];
};

/**
 * Load one or more Markdown sources and build a `PlaybookProjection`.
 *
 * Steps:
 * 1. Stream all Markdown inputs via `markdownASTs(markdownPaths)`.
 * 2. For each mdast root:
 *    - Visit `code` nodes.
 *    - If `isExecutableCodeCandidate(code)`, create an `Executable`.
 *    - If `isMateriazableCodeCandidate(code)`, create a `Materializable`.
 *    - If `isCodeDirectiveCandidate(code)`, create a `Directive`.
 *    - If `nodeIssues.is(code)`, attach it to the `issues` collection.
 * 3. After scanning everything:
 *    - Build `ExecutableTask` objects with dependency resolution via
 *      `executableDepsResolver`.
 *
 * Unobvious behavior:
 * - The same `spawnableIdentity` seen multiple times will invoke the
 *   appropriate `onDuplicate*` callback instead of throwing. This allows
 *   higher layers to implement "last one wins", "first one wins",
 *   or "warn and ignore" policies.
 * - `filter`, if provided, is applied *before* filling `executablesById`.
 *   This means filtered-out tasks never appear in the identity maps or in
 *   the dependency graph.
 *
 * @param markdownPaths
 *   A path/glob/URL or array accepted by `markdownASTs`. This can be a file
 *   path, directory, remote URL, or a collection of them.
 *
 * @param init
 *   Optional hooks to customize behavior:
 *
 *   - `filter`:
 *     Predicate to skip executables that do not match. Useful for
 *     environment- or tag-based selection of which tasks are in-scope.
 *
 *   - `onDuplicateExecutable`:
 *     Callback when two executables share the same identity. The callback
 *     receives the new executable and the existing identity map so it can
 *     decide how to handle conflicts.
 *
 *   - `onDuplicateMaterializable`:
 *     Equivalent to `onDuplicateExecutable`, but for materializables.
 *
 *   - `encountered`:
 *     Callback for each Markdown source as it is parsed. Good place for
 *     logging, UI progress, or building higher-level indices.
 *
 * @returns
 *   A fully populated `PlaybookProjection`, ready to be given to execution
 *   and interpolation layers.
 */
export async function playbooksFromFiles(
  markdownPaths: Parameters<typeof markdownASTs>[0],
  init?: {
    readonly filter?: (task: Executable) => boolean;
    readonly onDuplicateExecutable?: (
      r: Executable,
      byIdentity: Record<string, Executable>,
    ) => void;
    readonly onDuplicateMaterializable?: (
      r: Materializable,
      byIdentity: Record<string, Materializable>,
    ) => void;
    readonly encountered?: (projectable: MarkdownEncountered) => void;
  },
): Promise<PlaybookProjection> {
  const {
    onDuplicateExecutable,
    onDuplicateMaterializable,
    encountered,
    filter,
  } = init ?? {};
  const sources: MarkdownEncountered[] = [];
  const directives: Directive[] = [];
  const executablesById: Record<string, Executable> = {};
  const executables: Executable[] = [];
  const materializablesById: Record<string, Materializable> = {};
  const materializables: Materializable[] = [];
  const issues: (Code & {
    readonly data: { readonly issues: NodeIssue[] };
    readonly provenance: MarkdownEncountered;
  })[] = [];

  // Discover all executables, materializables and directives across all Markdown sources.
  for await (const src of markdownASTs(markdownPaths)) {
    sources.push(src);
    encountered?.(src);

    visit(src.mdastRoot, "code", (code) => {
      if (isExecutableCodeCandidate(code)) {
        const { isActionableCodeCandidate: _, ...candidate } = code;
        const executable: Executable = {
          ...candidate,
          provenance: src,
          origin: code,
        };

        if (!filter || filter(executable)) {
          executables.push(executable);

          if (candidate.spawnableIdentity in executablesById) {
            // Caller decides what to do with duplicates (warn, override, etc.).
            onDuplicateExecutable?.(executable, executablesById);
          } else {
            executablesById[candidate.spawnableIdentity] = executable;
          }
        }
      } else if (isMateriazableCodeCandidate(code)) {
        const { isActionableCodeCandidate: _, ...rest } = code;
        const storable: Materializable = {
          ...rest,
          provenance: src,
          origin: code,
        };

        // `spawnable` is a shallow clone of `code`; we attach provenance.
        materializables.push(storable);

        if (rest.materializableIdentity in materializablesById) {
          // Caller decides what to do with duplicates (warn, override, etc.).
          onDuplicateMaterializable?.(storable, materializablesById);
        } else {
          materializablesById[rest.materializableIdentity] = storable;
        }
      }

      if (isCodeDirectiveCandidate(code)) {
        const { isCodeDirectiveCandidate: _, ...directive } = code;
        directives.push({ ...directive, provenance: src });
      }

      if (nodeIssues.is(code)) {
        issues.push({ ...code, provenance: src });
      }
    });
  }

  // Resolve dependencies across all executables.
  // - `depsResolver` knows how to compute transitive deps + injected deps.
  const dr = executableDepsResolver(executables);

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
    issues,
  };
}

/**
 * Helper: build a dependency resolver for `Executable` tasks.
 *
 * This uses the generic `depsResolver` from `universal/depends.ts`, and
 * extends it with support for *implicit* injected dependencies:
 *
 * - Tasks may declare `--injected-dep` flags (e.g. in code fence PI).
 * - These are treated as regex patterns that match other task IDs.
 * - When a task is the *target* of an injected-dep pattern, the
 *   *source* task is added as an implicit dependency.
 *
 * Unobvious behavior:
 * - Injected dependencies are compiled lazily and cached on each task via
 *   `dataBag`. This avoids recompiling regular expressions every time the
 *   dependency graph is traversed.
 * - A special `*` pattern is treated as "match everything" and compiled
 *   as `/.*\/`, which effectively makes the task a prerequisite for all
 *   other tasks.
 * - Invalid regular expressions never throw from here; instead they are
 *   reported through `onInvalidInjectedDepRegEx` and ignored. This keeps
 *   the system robust in the face of typos in Markdown fences.
 *
 * @param catalog
 *   Iterable collection of `Executable`s that define the universe of tasks.
 *   Usually this is `PlaybookProjection.executables`.
 *
 * @param init
 *   Optional hooks:
 *
 *   - `onInvalidInjectedDepRegEx`:
 *     Callback invoked when a `--injected-dep` cannot be compiled as a
 *     regular expression. Receives:
 *       - the task `r`,
 *       - the bad `source` string,
 *       - the thrown `error`,
 *       - the `compiledList` built so far (for introspection / logging).
 *
 * @returns
 *   An object compatible with `depsResolver`’s result, exposing a `deps`
 *   method that merges:
 *   - explicit dependencies (from the task’s own args), and
 *   - implicit injected dependencies (from other tasks’ flags).
 */
export function executableDepsResolver(
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
