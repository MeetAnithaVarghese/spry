import { hasFlagOfType } from "../universal/cline.ts";
import { eventBus } from "../universal/event-bus.ts";
import { gitignore } from "../universal/gitignore.ts";
import { unsafeInterpolator } from "../universal/interpolate.ts";
import { shell, ShellBusEvents } from "../universal/shell.ts";
import {
  executeDAG,
  fail,
  ok,
  Task,
  TaskExecEventMap,
  TaskExecutionPlan,
  TaskExecutorBuilder,
} from "../universal/task.ts";
import { ensureTrailingNewline } from "../universal/text-utils.ts";
import { safeJsonStringify } from "../universal/tmpl-literal-aide.ts";
import { matchTaskNature, TaskCell, TaskDirectives } from "./cell.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type TaskExecContext = { runId: string };

export type TaskExecCapture = {
  cell: TaskCell<string>;
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
    const flags = tec.cell.parsedPI?.flags;
    if (flags && hasFlagOfType(flags, "gitignore")) {
      const gi = ci.slice("./".length);
      if (hasFlagOfType(flags, "gitignore", "string")) {
        await gitignore(gi, flags.gitignore);
      } else {
        await gitignore(gi);
      }
    }
  } else {
    capturedTaskExecs[ci] = tec;
  }
};

export function execTasksState(
  directives: TaskDirectives<Any, Any, Any, Any>,
  opts?: {
    unsafeInterp?: ReturnType<typeof unsafeInterpolator>;
    onCapture?: (
      ci: string,
      tec: TaskExecCapture,
      capturedTaskExecs: Record<string, TaskExecCapture>,
    ) => void | Promise<void>;
  },
) {
  const capturedTaskExecs = {} as Record<string, TaskExecCapture>;
  const defaults: Required<typeof opts> = {
    unsafeInterp: unsafeInterpolator({
      directives,
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

  const isCapturable = (cell: TaskCell<string>) =>
    cell.parsedPI &&
    ("capture" in cell.parsedPI.flags || "C" in cell.parsedPI.flags);

  const prepTaskExecCapture = (
    tec: Pick<TaskExecCapture, "cell" | "ctx" | "interpResult" | "execResult">,
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
    const { cell: { parsedPI } } = cap;
    const captureFlags = [
      parsedPI?.flags.capture,
      parsedPI?.flags.C,
    ].filter((v) => v !== undefined);

    const captureInstructions = captureFlags.flatMap((v) =>
      typeof v === "boolean"
        ? [parsedPI?.firstToken]
        : Array.isArray(v)
        ? v
        : [v]
    ).filter((v) => v !== undefined);

    for (const ci of captureInstructions) {
      await onCapture(ci, cap, capturedTaskExecs);
    }
  };

  // "unsafely" means we're using JavaScript "eval"
  async function interpolateUnsafely(
    cell: TaskCell<string>,
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
    const source = cell.source;
    if (!cell.parsedPI?.hasEitherFlagOfType?.("interpolate", "I", "boolean")) {
      return { status: "unmodified", source };
    }

    try {
      // NOTE: This is intentionally unsafe. Do not feed untrusted content.
      // Assume you're treating code cell blocks as fully trusted source code.
      const mutated = await unsafeInterp.interpolate(source, {
        ...ctx,
        cell,
        captured: capturedTaskExecs,
        partial: async (
          name: string,
          partialLocals?: Record<string, unknown>,
        ) => {
          const found = directives.partials.get(name);
          if (found) {
            const partialCell = directives.partialDirectives.find((pd) =>
              pd.partialDirective.partial.identity == found.identity
            );
            const { content: partial, interpolate, locals } = await found
              .content({
                cell,
                captured: capturedTaskExecs,
                ...ctx,
                ...partialLocals,
                partial: partialCell,
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
  T extends Task,
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
  const exec = new TaskExecutorBuilder<Task, Context>()
    .handle(
      matchTaskNature("TASK"),
      async (cell, ctx) => {
        const interpResult = await tei.interpolateUnsafely(cell, ctx);
        if (interpResult.status) {
          const execResult = await sh.auto(interpResult.source);
          if (isCapturable(cell)) {
            await captureTaskExec(
              prepTaskExecCapture({ cell, ctx, interpResult, execResult }),
            );
          }
          return ok(ctx);
        } else {
          return fail(ctx, interpResult.error);
        }
      },
    )
    .handle(
      matchTaskNature("CONTENT"),
      async (cell, ctx) => {
        const interpResult = await tei.interpolateUnsafely(cell, ctx);
        if (interpResult.status) {
          if (isCapturable(cell)) {
            await captureTaskExec(
              prepTaskExecCapture({
                cell,
                ctx,
                interpResult,
                /* just content, no execResult */
              }),
            );
          }
          return ok(ctx);
        } else {
          return fail(ctx, interpResult.error);
        }
      },
    )
    .build();

  return await executeDAG(plan, exec, { eventBus: opts?.tasksBus });
}
