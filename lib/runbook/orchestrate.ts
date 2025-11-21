import { visit } from "unist-util-visit";
import { markdownASTs, Yielded } from "../remark/mdastctl/io.ts";
import {
  CodeWithFrontmatterData,
  CodeWithFrontmatterNode,
  isCodeWithFrontmatterNode,
} from "../remark/plugin/node/code-frontmatter.ts";

import { z } from "@zod/zod";
import { Code, Node } from "types/mdast";
import {
  codePartialsCollection,
  isCodePartialNode,
} from "../remark/plugin/node/code-partial.ts";
import { languageRegistry } from "../universal/code.ts";
import { depsResolver } from "../universal/depends.ts";
import { eventBus } from "../universal/event-bus.ts";
import { gitignore } from "../universal/gitignore.ts";
import { unsafeInterpolator } from "../universal/interpolate.ts";
import { PosixPIQuery, queryPosixPI } from "../universal/posix-pi.ts";
import { shell, ShellBusEvents } from "../universal/shell.ts";
import {
  executeDAG,
  fail,
  ok,
  Task,
  TaskExecEventMap,
  TaskExecutionPlan,
} from "../universal/task.ts";
import { ensureTrailingNewline } from "../universal/text-utils.ts";
import { safeJsonStringify } from "../universal/tmpl-literal-aide.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const flexibleTextSchema = z.union([z.string(), z.array(z.string())]);
export type FlexibleText = z.infer<typeof flexibleTextSchema>;

/**
 * codeSpawnablePiFlags = {
 *   capture?: string;
 *   interpolate?: string;
 *   C?: string;  // shorthand
 *   I?: string;  // shorthand
 * }
 *
 * The transform ensures:
 *   - if C is present → capture = C
 *   - if I is present → interpolate = I
 */
export const codeSpawnablePiFlagsSchema = z.object({
  descr: z.string().optional(),
  dep: flexibleTextSchema.optional(), // collected as multiple --dep
  capture: z.string().optional(),
  interpolate: z.boolean().optional(),
  silent: z.boolean().optional(),
  gitignore: z.union([z.string(), z.boolean()]).optional(),
  graph: flexibleTextSchema.optional(),

  // shortcuts
  /* capture */ C: z.string().optional(),
  /* dep */ D: flexibleTextSchema.optional(),
  /* graph */ G: flexibleTextSchema.optional(),
  /* interpolate */ I: z.boolean().optional(),
}).transform((raw) => {
  const depRaw = raw.D ?? raw.dep;
  const graphRaw = raw.G ?? raw.graph;
  const capture = raw.C ?? raw.capture;
  return {
    description: raw.descr,
    deps: depRaw ? typeof depRaw === "string" ? [depRaw] : depRaw : undefined,
    capture,
    captureDest: capture
      ? capture.startsWith("./") ? "file" as const : "memory" as const
      : undefined,
    interpolate: raw.I ?? raw.interpolate,
    gitignore: raw.gitignore,
    graphs: graphRaw
      ? typeof graphRaw === "string" ? [graphRaw] : graphRaw
      : undefined,
    silent: raw.silent,
  };
});

export type CodeSpawnablePiFlags = z.infer<typeof codeSpawnablePiFlagsSchema>;

export const spawnableLangIds = ["shell"] as const;
export type SpawnableLangIds = typeof spawnableLangIds[number];
export const spawnableLangSpecs = spawnableLangIds.map((lid) => {
  const langSpec = languageRegistry.get(lid);
  if (!langSpec) throw new Error("this should never happen");
  return langSpec;
});

/** The structured enrichment attached to a code node by this plugin. */
export type CodeSpawnable = {
  readonly identity: string;
  readonly piq: PosixPIQuery<CodeSpawnablePiFlags>;
  readonly cspif: CodeSpawnablePiFlags;
};

export const CODESPAWNABLE_KEY = "codeSpawnable" as const;
export type CodeSpawnableData = CodeWithFrontmatterData & {
  readonly codeSpawnable: CodeSpawnable;
  [key: string]: unknown;
};

export type CodeSpawnableNode = Code & { data: CodeSpawnableData };

export type SpawnableTask = Task<{ code: CodeSpawnableNode }>;

/**
 * Type guard: returns true if a node is a `code` node that already
 * carries CodeSpawnable data at the default store key.
 */
export function isCodeSpawnableNode(node: Node): node is CodeSpawnableNode {
  if (node.type === "code" && node.data && CODESPAWNABLE_KEY in node.data) {
    return true;
  }
  return false;
}

export function spawnableDepsResolver(
  catalog: Iterable<CodeSpawnableNode>,
  init?: { onImplicitTasksError?: () => void },
) {
  const { onImplicitTasksError } = init ?? {};

  return depsResolver(catalog, {
    getId: (node) => node.data.codeSpawnable.identity,

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
      const errors: { taskId: string; regEx: string; error: unknown }[] = [];

      const tasks = Array.from(catalog).map((n) =>
        n.data.codeSpawnable.identity
      );
      for (const task of catalog) {
        const {
          codeFM: { pi: { flags } },
          codeSpawnable: { identity: taskId },
        } = task.data;

        if (!flags || typeof flags !== "object") continue;
        if (!("injected-dep" in flags)) continue;

        // Normalize `--injected-dep` forms into an array of string patterns
        const diFlag = flags["injected-dep"];
        let di: string[] = [];

        if (typeof diFlag === "boolean") {
          if (diFlag === true) {
            di = ["*"];
          }
        } else if (typeof diFlag === "string") {
          di = [diFlag];
        } else if (Array.isArray(diFlag)) {
          di = diFlag.filter((x) => typeof x === "string");
        }

        if (di.length === 0) continue;

        // Compile/cache regexes if not already done
        if (!Array.isArray(flags[".injected-dep-cache"])) {
          const compiledList: RegExp[] = [];

          for (const expr of di) {
            const source = expr === "*" ? ".*" : expr;

            try {
              compiledList.push(new RegExp(source));
            } catch (error) {
              // Record invalid regex source
              errors.push({ taskId, regEx: expr, error });
              // skip adding invalid one
            }
          }

          // deno-lint-ignore no-explicit-any
          (flags as any)[".injected-dep-cache"] = compiledList;
        }

        // deno-lint-ignore no-explicit-any
        const cached = (flags as any)[".injected-dep-cache"] as RegExp[];

        if (!Array.isArray(cached) || cached.length === 0) {
          // nothing valid compiled, move on
          continue;
        }

        // Check whether ANY of the compiled regexes matches the requested taskId
        let matches = false;
        for (const re of cached) {
          if (
            re instanceof RegExp && re.test(node.data.codeSpawnable.identity)
          ) {
            matches = true;
            break;
          }
        }

        if (!matches) continue;

        if (
          !tasks.includes(taskId) &&
          !injected.includes(taskId)
        ) {
          injected.push(taskId);
        }
      }

      onImplicitTasksError?.();
      return injected.length ? injected : undefined;
    },
  });
}

export type TaskExecContext = { runId: string };

export type TaskExecCapture = {
  cell: CodeSpawnableNode;
  ctx: TaskExecContext;
  interpResult: Awaited<
    ReturnType<ReturnType<typeof execTasksState>["interpolateUnsafely"]>
  >;
  execResult?: Awaited<ReturnType<ReturnType<typeof shell>["auto"]>>;

  text: () => string;
  json: () => unknown;
};

export const typicalOnCapture = async (
  ci: string,
  tec: TaskExecCapture,
  capturedTaskExecs: Record<string, TaskExecCapture>,
) => {
  if (ci.startsWith("./")) {
    await Deno.writeTextFile(ci, ensureTrailingNewline(tec.text()));
  } else {
    capturedTaskExecs[ci] = tec;
  }
};

export const gitignorableOnCapture = async (
  ci: string,
  tec: TaskExecCapture,
  capturedTaskExecs: Record<string, TaskExecCapture>,
) => {
  if (ci.startsWith("./")) {
    await Deno.writeTextFile(ci, ensureTrailingNewline(tec.text()));
    const { gitignore: ignore } = tec.cell.data.codeSpawnable.cspif;
    if (ignore) {
      const gi = ci.slice("./".length);
      if (typeof ignore === "string") {
        await gitignore(gi, ignore);
      } else {
        await gitignore(gi);
      }
    }
  } else {
    capturedTaskExecs[ci] = tec;
  }
};

export function execTasksState(
  tasks: Iterable<{ code: CodeWithFrontmatterNode }>,
  partialsCollec: ReturnType<typeof codePartialsCollection>,
  opts?: {
    unsafeInterp?: ReturnType<typeof unsafeInterpolator>;
    onCapture?: (
      ci: string,
      tec: TaskExecCapture,
      capturedTaskExecs: Record<string, TaskExecCapture>,
    ) => void | Promise<void>;
  },
) {
  const capturedTaskExecs = {} as Record<
    string,
    TaskExecCapture
  >;
  const defaults: Required<typeof opts> = {
    unsafeInterp: unsafeInterpolator({
      directives: tasks,
      safeJsonStringify,
      capturedTaskExecs,
    }),
    onCapture: typicalOnCapture,
  };
  const {
    unsafeInterp = defaults.unsafeInterp,
    onCapture = defaults.onCapture,
  } = opts ?? {};
  const td = new TextDecoder();

  const isCapturable = (cell: CodeSpawnableNode) =>
    cell.data.codeSpawnable.cspif.capture;

  const prepTaskExecCapture = (
    tec: Pick<
      TaskExecCapture,
      "cell" | "ctx" | "interpResult" | "execResult"
    >,
  ) => {
    const text = () => {
      if (tec.execResult) {
        if (Array.isArray(tec.execResult)) {
          return tec.execResult.map((er) => td.decode(er.stdout)).join("\n");
        } else {
          return td.decode(tec.execResult.stdout);
        }
      } else {
        return tec.interpResult.source;
      }
    };
    const json = () => JSON.parse(text());
    return { ...tec, text, json } satisfies TaskExecCapture;
  };

  const captureTaskExec = async (cap: TaskExecCapture) => {
    const { cell: { data: { codeFM: { pi } } } } = cap;
    const captureFlags = [
      pi.flags.capture,
      pi.flags.C,
    ].filter((v) => v !== undefined);

    const captureInstructions = captureFlags.flatMap((v) =>
      typeof v === "boolean" ? [pi.pos[0]] : Array.isArray(v) ? v : [v]
    ).filter((v) => v !== undefined).filter((v) => typeof v === "string");

    for (const ci of captureInstructions) {
      await onCapture(ci, cap, capturedTaskExecs);
    }
  };

  // "unsafely" means we're using JavaScript "eval"
  async function interpolateUnsafely(
    cell: { code: CodeSpawnableNode },
    ctx: TaskExecContext,
  ): Promise<
    & { status: false | "unmodified" | "mutated" }
    & ({ status: "mutated"; source: string } | {
      status: "unmodified";
      source: string;
    } | {
      status: false;
      source: string;
      error: unknown;
    })
  > {
    const { value: source, data: { codeSpawnable: { cspif } } } = cell.code;
    if (!cspif.interpolate) {
      return { status: "unmodified", source };
    }

    try {
      // NOTE: This is intentionally unsafe. Do not feed untrusted content.
      // Assume you're treating code cell blocks as fully trusted source code.
      const mutated = await unsafeInterp.interpolate(source, {
        ...ctx,
        cell: cell.code,
        safeJsonStringify,
        captured: capturedTaskExecs,
        partial: async (
          name: string,
          partialLocals?: Record<string, unknown>,
        ) => {
          const found = partialsCollec.get(name);
          if (found) {
            const { content: partial, interpolate, locals } = await found.data
              .codePartial.content({
                cell: cell.code,
                safeJsonStringify,
                captured: capturedTaskExecs,
                ...ctx,
                ...partialLocals,
                partial: found.data.codePartial,
              });
            if (!interpolate) return partial;
            return await unsafeInterp.interpolate(partial, locals, [{
              template: partial,
            }]);
          } else {
            return `/* partial '${name}' not found */`;
          }
        },
      });
      if (mutated !== source) return { status: "mutated", source: mutated };
      return { status: "unmodified", source };
    } catch (error) {
      return { status: false, error, source };
    }
  }

  return {
    isCapturable,
    onCapture,
    unsafeInterp,
    interpolateUnsafely,
    capturedTaskExecs,
    captureTaskExec,
    prepTaskExecCapture,
  };
}

export type ExecTasksState = ReturnType<typeof execTasksState>;

export async function executeTasks<
  T extends SpawnableTask,
  Context extends TaskExecContext = TaskExecContext,
>(
  plan: TaskExecutionPlan<T>,
  tei: ExecTasksState,
  opts?: {
    shellBus?: ReturnType<typeof eventBus<ShellBusEvents>>;
    tasksBus?: ReturnType<typeof eventBus<TaskExecEventMap<T, Context>>>;
  },
) {
  const { isCapturable, captureTaskExec, prepTaskExecCapture } = tei;
  const sh = shell({ bus: opts?.shellBus });
  return await executeDAG(plan, async (task, ctx) => {
    const interpResult = await tei.interpolateUnsafely(task, ctx);
    if (interpResult.status) {
      const execResult = await sh.auto(interpResult.source, undefined, task);
      if (isCapturable(task.code)) {
        await captureTaskExec(
          prepTaskExecCapture({
            cell: task.code,
            ctx,
            interpResult,
            execResult,
          }),
        );
      }
      return ok(ctx);
    } else {
      return fail(ctx, interpResult.error);
    }
  }, { eventBus: opts?.tasksBus });
}

/**
 * Creates a predicate function that determines whether a `CodeSpawnableNode`
 * should be considered "in graph" based on optional candidate graph names.
 *
 * Behavior:
 *
 * - **If `candidates` is provided and non-empty:**
 *   - Only tasks whose `cspif.graphs` array contains **at least one** of the
 *     candidate graph names will pass (return `true`).
 *   - Tasks with no `cspif.graphs` field fail (return `false`).
 *
 * - **If `candidates` is omitted or an empty array:**
 *   - This switches to "exclude anything with a graph name" mode.
 *   - Tasks **with one or more graph names** return `false`.
 *   - Tasks **with no graph names** return `true`.
 *
 * In short:
 * - With candidates → **include only matching graph nodes**.
 * - Without candidates → **exclude all graph-associated nodes**, include the rest.
 *
 * @param candidates Optional list of graph names used for inclusion filtering.
 * @returns A predicate `(task: CodeSpawnableNode) => boolean` implementing the above logic.
 */
export function isInGraphFn(candidates?: string[]) {
  if (candidates && candidates.length) {
    const graphs = new Set(candidates);
    return (task: CodeSpawnableNode) => {
      const { cspif } = task.data.codeSpawnable;
      if (!cspif.graphs) return false;
      return cspif.graphs.filter((g) => graphs.has(g)) ? true : false;
    };
  } else {
    return (task: CodeSpawnableNode) => {
      const { cspif } = task.data.codeSpawnable;
      return cspif.graphs && cspif.graphs.length > 0 ? false : true;
    };
  }
}

export async function markdownTasks(
  mdASTs: ReturnType<typeof markdownASTs>,
  options?: { includeTask?: (node: CodeSpawnableNode) => boolean },
) {
  const isSpawnable = (code: Code) =>
    spawnableLangSpecs.find((lang) =>
      lang.id == code.lang || lang.aliases?.find((a) => a == code.lang)
    );

  const tasksWithOrigin: {
    taskId: () => string; // satisfies Task interface
    taskDeps: () => string[]; // satisfies Task interface
    code: CodeSpawnableNode;
    md: Yielded<typeof mdASTs>;
  }[] = [];
  for await (const md of mdASTs) {
    visit(md.mdastRoot, "code", (code) => {
      if (
        isSpawnable(code) && isCodeWithFrontmatterNode(code) &&
        !isCodePartialNode(code)
      ) {
        // spawnable code nodes must have at least an identifier
        if (code.data.codeFM.pi.posCount) {
          if (!(code.data as Any)[CODESPAWNABLE_KEY]) {
            const ppiq = queryPosixPI<CodeSpawnablePiFlags>(
              code.data.codeFM.pi,
              undefined,
              { zodSchema: codeSpawnablePiFlagsSchema },
            );
            const cspif = ppiq.safeFlags();
            if (cspif.success) {
              const cs: CodeSpawnable = {
                identity: ppiq.getFirstBareWord()!,
                piq: ppiq,
                cspif: cspif.data,
              };
              (code.data as Any)[CODESPAWNABLE_KEY] = cs;
            } else {
              console.error(
                `Error reading code spawnable flags (line ${code.position?.start.line}): ${cspif.error} in \n ${
                  JSON.stringify(code.data.codeFM.pi)
                }`,
              );
            }
          }

          // verifies that it's properly guarded
          if (
            isCodeSpawnableNode(code) &&
            (!options?.includeTask || options.includeTask(code))
          ) {
            const { codeSpawnable } = code.data;
            tasksWithOrigin.push({
              taskId: () => codeSpawnable.identity,
              taskDeps: () => codeSpawnable.cspif.deps ?? [],
              code,
              md,
            });
          }
        }
      }
    });
  }

  // we want to resolve dependencies in tasks across all markdowns loaded
  const dr = spawnableDepsResolver(tasksWithOrigin.map((t) => t.code));
  return tasksWithOrigin.map((t) => {
    return {
      ...t,
      // overwrite the final dependencies with "injected" ones, too
      deps: () => dr.deps(t.taskId(), t.taskDeps()),
    };
  });
}
