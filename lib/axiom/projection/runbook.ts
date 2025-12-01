import { visit } from "unist-util-visit";
import { depsResolver } from "../../universal/depends.ts";
import { markdownASTs, MarkdownEncountered } from "../io/mod.ts";
import { dataBag } from "../mdast/data-bag.ts";
import {
  isSpawnableCodeCandidate,
  SpawnableCodeCandidate,
} from "../remark/spawnable-code-candidates.ts";
import {
  CodeDirectiveCandidate,
  isCodeDirectiveCandidate,
} from "../remark/code-directive-candidates.ts";
import {
  partialContent,
  partialContentCollection as partialsCollection,
} from "../../universal/partial.ts";

export type Directive =
  & Omit<CodeDirectiveCandidate<string, string>, "isCodeDirectiveCandidate">
  & { readonly provenance: MarkdownEncountered };

export type Runnable =
  & Omit<SpawnableCodeCandidate, "isSpawnableCodeCandidate">
  & { readonly provenance: MarkdownEncountered };

export type RunnableTask = Runnable & {
  readonly taskId: () => string; // satisfies lib/universal/task.ts interface
  readonly taskDeps: () => string[]; // satisfies lib/universal/task.ts interface
};

export type RunbookProjection = {
  readonly runnablesById: Record<string, Runnable>;
  readonly runnables: readonly Runnable[];
  readonly tasks: readonly RunnableTask[];
  readonly directives: readonly Directive[];
  readonly partials: ReturnType<typeof partialsCollection>;
};

export async function runbooksFromFiles(
  markdownPaths: Parameters<typeof markdownASTs>[0],
  init?: {
    readonly filter?: (task: Runnable) => boolean;
    readonly onDuplicateRunnable?: (
      r: Runnable,
      byIdentity: Record<string, Runnable>,
    ) => void;
    readonly encountered?: (projectable: MarkdownEncountered) => void;
  },
) {
  const { onDuplicateRunnable, encountered, filter } = init ?? {};
  const directives: Directive[] = [];
  const runnablesById: Record<string, Runnable> = {};
  const runnables: Runnable[] = [];
  for await (const src of markdownASTs(markdownPaths)) {
    encountered?.(src);

    visit(src.mdastRoot, "code", (code) => {
      if (isSpawnableCodeCandidate(code)) {
        const { isSpawnableCodeCandidate: _, ...spawnable } = code;
        const runnable: Runnable = { ...spawnable, provenance: src };
        if (!filter || filter(runnable)) {
          // now spawnable is a shallow clone of code
          runnables.push(runnable);
          if (spawnable.identity in runnablesById) {
            onDuplicateRunnable?.(runnable, runnablesById);
          } else {
            runnablesById[runnable.identity] = runnable;
          }
        }
      } else if (isCodeDirectiveCandidate(code)) {
        const { isCodeDirectiveCandidate: _, ...rest } = code;
        directives.push({ ...rest, provenance: src });
      }
    });
  }

  // we want to resolve dependencies in tasks across all markdowns loaded
  const dr = runnableDepsResolver(runnables);
  const tasks = runnables.map((o) => ({
    ...o,
    taskId: () => o.identity, // satisfies structure of Task interface
    taskDeps: () => dr.deps(o.identity, o.args.deps), // satisfies structure of Task interface
  }));

  const partials = partialsCollection();
  for (const d of directives) {
    if (d.directive === "PARTIAL") {
      const { pi: { flags }, attrs } = d.instructions;
      const hasFlag = (k: string) =>
        k in flags && flags[k] !== false && flags[k] !== undefined;
      const injectGlobs = flags.inject === undefined
        ? []
        : Array.isArray(flags.inject)
        ? (flags.inject as string[])
        : [String(flags.inject)];
      partials.register(partialContent(
        d.identity,
        d.value,
        attrs,
        {
          injectGlobs,
          registerIssue: (...args) => console.log(...args),
          append: hasFlag("append"),
          prepend: hasFlag("prepend"),
        },
      ));
    }
  }

  return {
    runnables,
    runnablesById,
    tasks,
    directives,
    partials,
  } satisfies RunbookProjection;
}

export function runnableDepsResolver(
  catalog: Iterable<Runnable>,
  init?: {
    onInvalidInjectedDepRegEx?: (
      r: Runnable,
      source: string,
      error: unknown,
      compiledList: RegExp[],
    ) => void;
  },
) {
  const { onInvalidInjectedDepRegEx } = init ?? {};

  const injectedDepCache = dataBag<"injectedDepCache", RegExp[], Runnable>(
    "injectedDepCache",
    (r) => {
      const compiledList: RegExp[] = [];
      for (const expr of r.args.injectedDep) {
        const source = expr === "*" ? ".*" : expr;

        try {
          compiledList.push(new RegExp(source));
        } catch (error) {
          // Record invalid regex source
          onInvalidInjectedDepRegEx?.(r, source, error, compiledList);
          // skip adding invalid one
        }
      }
      return compiledList;
    },
  );

  return depsResolver(catalog, {
    getId: (node) => node.identity,

    /**
     * Find tasks that should be *implicitly* injected as dependencies of `taskId`
     * based on other tasks' `--injected-dep` flags, and report invalid regexes.
     *
     * Behavior:
     *
     * - Any task may declare `--injected-dep`. The value can be:
     *   - boolean true  → means ["*"] (match all taskIds)
     *   - string        → treated as [that string]
     *   - string[]      → used as-is
     *
     * - Each string is treated as a regular expression source. We compile all of them
     *   once and cache them in `t.parsedPI.flags[".injected-dep-cache"]` as `RegExp[]`.
     *
     * - Special case: "*" means "match everything", implemented as `/.*\/`.
     *
     * - If ANY compiled regex for task `t` matches the given `taskId`, then that task’s
     *   `parsedPI.firstToken` (the task's own name/id) will be considered an injected
     *   dependency. It will be added to the returned `injected` list unless it is already
     *   present in `taskDeps` or already added.
     *
     * Reliability:
     *
     * - The only error we surface is regex compilation failure. If a pattern cannot be
     *   compiled, it is skipped and recorded in `errors` as `{ taskId, regEx }`.
     *
     * - No exceptions propagate. Bad inputs are ignored safely.
     */
    getImplicit: (node) => {
      const injected: string[] = [];

      const tasks = Array.from(catalog).map((n) => n.identity);
      for (const task of catalog) {
        const taskId = task.identity;
        const di = task.args.injectedDep;
        if (di.length === 0) continue;

        if (injectedDepCache.is(task)) {
          // Check whether ANY of the compiled regexes matches the requested taskId
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

        if (!tasks.includes(taskId) && !injected.includes(taskId)) {
          injected.push(taskId);
        }
      }

      return injected.length ? injected : undefined;
    },
  });
}
