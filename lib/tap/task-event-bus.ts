import { eventBus } from "../universal/event-bus.ts";
import {
  Task,
  TaskExecEventMap,
  TaskExecutionResult,
} from "../universal/task.ts";
import {
  type Diagnostics,
  stringify as tapStringify,
  TapContentBuilder,
} from "./protocol.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/**
 * Collect TaskExecEventMap events and produce a TAP v14 report (as TapContent + string).
 *
 * Usage:
 *   const { bus, stringify } = testAnythingProtocolTaskEventBus<MyTask, Ctx>({});
 *   await executeDAG(plan, exec, { eventBus: bus, ctx });
 *   await Deno.writeTextFile("run.tap", stringify());
 */
export function testAnythingProtocolTaskEventBus<
  T extends Task,
  Context,
>(init?: {
  tapVersion?: number; // default 14
  suiteTitle?: string; // optional footer
  includeDagComments?: boolean; // default true
  includePlanComments?: boolean; // default true
  includeTimingDiagnostics?: boolean; // default true
  includeStdIO?: "none" | "stderr" | "stdout" | "both"; // default "stderr"
  maxStdIOBytes?: number; // default 16_384
  includeErrorStack?: boolean; // default false
  unresolvedDisposition?: "skip" | "fail"; // default "skip"
  /** If true, keep trailing empty line as an element in `lines` (default false). */
  keepTrailingEmptyLine?: boolean;
}) {
  const cfg = {
    tapVersion: init?.tapVersion ?? 14,
    suiteTitle: init?.suiteTitle,
    includeDagComments: init?.includeDagComments ?? true,
    includePlanComments: init?.includePlanComments ?? true,
    includeTimingDiagnostics: init?.includeTimingDiagnostics ?? true,
    includeStdIO: init?.includeStdIO ?? "stderr",
    maxStdIOBytes: init?.maxStdIOBytes ?? 16_384,
    includeErrorStack: init?.includeErrorStack ?? false,
    unresolvedDisposition: init?.unresolvedDisposition ?? "skip",
    keepTrailingEmptyLine: init?.keepTrailingEmptyLine ?? false,
  } as const;

  const bus = eventBus<TaskExecEventMap<T, Context>>();

  // ---- collected state (built later into TAP) ----
  let planIds: readonly string[] = [];
  let unresolvedIds: readonly string[] = [];
  let missingDeps: Readonly<Record<string, string[]>> = {};
  const readyAtStart: string[] = [];

  const endedInOrder: Array<{
    id: string;
    result: TaskExecutionResult<Context>;
  }> = [];

  const scheduledInOrder: string[] = [];
  const startedAtById = new Map<string, Date>();
  const taskById = new Map<string, T>();

  const runMeta: {
    startedAt?: Date;
    endedAt?: Date;
    durationMs?: number;
    totals?: Any;
    ctx?: Context;
    topLevelError?: Any;
  } = {};

  // TAP output like the other text event buses
  const lines: string[] = [];

  // ---- helpers ----
  const safeIso = (d?: Date) => (d ? d.toISOString() : undefined);

  const truncateBytes = (u: Uint8Array, max: number) =>
    u.byteLength <= max ? u : u.slice(0, max);

  const decodeUtf8 = (u?: Uint8Array) => {
    if (!u || !(u instanceof Uint8Array)) return undefined;
    try {
      const cut = truncateBytes(u, cfg.maxStdIOBytes);
      const text = new TextDecoder().decode(cut);
      return cut.byteLength < u.byteLength
        ? `${text}\n<<truncated: ${u.byteLength - cut.byteLength} bytes>>`
        : text;
    } catch {
      return `<<${u.byteLength} bytes: non-UTF8>>`;
    }
  };

  const resultDiagnostics = (
    id: string,
    result: TaskExecutionResult<Context>,
  ): Diagnostics => {
    const diag: Diagnostics = {
      taskId: id,
      success: result.success,
      exitCode: result.exitCode,
    };

    if (cfg.includeTimingDiagnostics) {
      diag.startedAt = safeIso((result as Any).startedAt);
      diag.endedAt = safeIso((result as Any).endedAt);
      const s = (result as Any).startedAt instanceof Date
        ? (result as Any).startedAt.getTime()
        : undefined;
      const e = (result as Any).endedAt instanceof Date
        ? (result as Any).endedAt.getTime()
        : undefined;
      if (typeof s === "number" && typeof e === "number") {
        diag.durationMs = e - s;
      }
    }

    if (cfg.includeStdIO === "stderr" || cfg.includeStdIO === "both") {
      const bytes = result.success ? undefined : result.stderr?.();
      const text = decodeUtf8(bytes);
      if (text) diag.stderr = text;
    }
    if (cfg.includeStdIO === "stdout" || cfg.includeStdIO === "both") {
      const bytes = result.success ? result.stdout?.() : undefined;
      const text = decodeUtf8(bytes);
      if (text) diag.stdout = text;
    }

    const err = (result as Any).error;
    if (!result.success && err != null) {
      if (err instanceof Error) {
        diag.error = { name: err.name, message: err.message };
        if (cfg.includeErrorStack && err.stack) {
          (diag as Any).error.stack = err.stack;
        }
      } else {
        diag.error = String(err);
      }
    }

    const miss = missingDeps[id];
    if (miss?.length) diag.missingDeps = miss;

    return diag;
  };

  const splitTapToLines = (tapText: string): string[] => {
    const out = tapText.split("\n");
    if (
      !cfg.keepTrailingEmptyLine && out.length && out[out.length - 1] === ""
    ) {
      out.pop();
    }
    return out;
  };

  // ---- listeners ----
  bus.on("run:start", ({ ctx, startedAt }) => {
    runMeta.ctx = ctx;
    runMeta.startedAt = startedAt;
  });

  bus.on("plan:ready", ({ ids, unresolved, missingDeps: md }) => {
    planIds = ids;
    unresolvedIds = unresolved;
    missingDeps = md;
  });

  bus.on("dag:ready", ({ ids }) => {
    readyAtStart.length = 0;
    readyAtStart.push(...ids);
  });

  bus.on("task:scheduled", ({ id }) => {
    scheduledInOrder.push(id);
  });

  bus.on("task:start", ({ id, task, at }) => {
    taskById.set(id, task);
    startedAtById.set(id, at);
  });

  bus.on("task:end", ({ id, result }) => {
    endedInOrder.push({ id, result });
  });

  bus.on("run:end", ({ endedAt, durationMs, totals }) => {
    runMeta.endedAt = endedAt;
    runMeta.durationMs = durationMs;
    runMeta.totals = totals;

    // Generate TAP lines at the end of the run, like other text buses.
    lines.length = 0;
    const tap = tapStringify(tapContent());
    lines.push(...splitTapToLines(tap));
  });

  bus.on("error", ({ message, cause, taskId, stage }) => {
    runMeta.topLevelError = {
      message,
      stage,
      taskId,
      cause: cause instanceof Error
        ? {
          name: cause.name,
          message: cause.message,
          ...(cfg.includeErrorStack && cause.stack
            ? { stack: cause.stack }
            : {}),
        }
        : (cause != null ? String(cause) : undefined),
    };
  });

  // ---- builders ----
  const tapContent = () => {
    const b = new TapContentBuilder<string, Diagnostics>(cfg.tapVersion);
    const bb = b.bb;

    if (cfg.includePlanComments) {
      if (runMeta.startedAt) {
        bb.comment(`run:start ${runMeta.startedAt.toISOString()}`);
      }
      if (planIds.length) bb.comment(`plan:ids count=${planIds.length}`);
      if (Object.keys(missingDeps).length) {
        bb.comment(`plan:missingDeps count=${Object.keys(missingDeps).length}`);
        for (const [id, deps] of Object.entries(missingDeps)) {
          bb.comment(`missingDeps ${id} -> ${deps.join(", ")}`);
        }
      }
      if (unresolvedIds.length) {
        bb.comment(`plan:unresolved count=${unresolvedIds.length}`);
      }
    }

    if (cfg.includeDagComments && readyAtStart.length) {
      bb.comment(`dag:ready ${readyAtStart.join(", ")}`);
    }

    for (const { id, result } of endedInOrder) {
      const diag = resultDiagnostics(id, result);
      const startedAt = startedAtById.get(id);
      if (startedAt && cfg.includeTimingDiagnostics) {
        diag.observedStartAt = startedAt.toISOString();
      }

      bb.content.push({
        nature: "test-case",
        ok: result.success,
        description: id,
        diagnostics: diag,
      });
    }

    const executed = new Set(endedInOrder.map((e) => e.id));
    for (const id of unresolvedIds) {
      if (executed.has(id)) continue;

      const ok = cfg.unresolvedDisposition === "skip" ? true : false;
      const directive = cfg.unresolvedDisposition === "skip"
        ? {
          nature: "SKIP",
          reason: "unresolved (cycle or blocked dependency chain)",
        } as const
        : undefined;

      const diag: Diagnostics = {
        taskId: id,
        unresolved: true,
        missingDeps: missingDeps[id] ?? [],
      };

      bb.content.push({
        nature: "test-case",
        ok,
        description: id,
        directive,
        diagnostics: diag,
      });
    }

    if (cfg.suiteTitle) {
      b.footers.push({ nature: "footer", content: cfg.suiteTitle });
    }
    if (runMeta.endedAt) {
      b.footers.push({
        nature: "footer",
        content: `run:end ${runMeta.endedAt.toISOString()}`,
      });
    }
    if (typeof runMeta.durationMs === "number") {
      b.footers.push({
        nature: "footer",
        content: `durationMs=${runMeta.durationMs}`,
      });
    }

    if (runMeta.topLevelError) {
      b.footers.push({
        nature: "footer",
        content: `error=${JSON.stringify(runMeta.topLevelError)}`,
      });
    }

    if (runMeta.totals) {
      b.footers.push({
        nature: "footer",
        content: `totals=${JSON.stringify(runMeta.totals)}`,
      });
    }

    return b.tapContent();
  };

  return { bus, lines, tapContent };
}
