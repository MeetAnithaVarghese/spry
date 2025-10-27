/**
 * Task graph planning and deterministic, serial DAG execution utilities.
 *
 * This module provides two core capabilities:
 * 1) `executionPlan()` — builds a reproducible execution plan from a set of
 *    lightweight task descriptors (`Task`) that expose an id and a list of
 *    dependencies. The plan includes useful graph views (ids, byId, edges,
 *    adjacency, indegree), “waves”/layers for natural parallel groupings, and
 *    a topological order (`dag`) when no cycles exist.
 * 2) `executeDAG()` — walks a previously built plan in stable, definition-order
 *    fashion and invokes a user-supplied async `execute()` function for each
 *    task. Execution is serial by design, but the plan’s `layers` can be used
 *    elsewhere for parallel scheduling if needed.
 *
 * Key properties:
 * - Determinism: ties are broken by original definition order; edges are added
 *   in the same stable sequence, producing stable `layers`, `dag`, and events.
 * - Robust planning: declared-but-missing dependencies are captured in
 *   `missingDeps` (they do not create edges). `unresolved` lists ids that could
 *   not be scheduled due to cycles or unmet chains.
 * - Non-destructive indegree: `executionPlan()` returns an `indegree` snapshot
 *   for introspection while `executeDAG()` operates on an internal copy.
 * - Event hooks: `executeDAG()` can emit lifecycle events via an optional
 *   event bus created by `eventBus<TaskExecEventMap<…>>()`.
 *
 * Definitions:
 * - Task: any object with `taskId(): string` and `taskDeps(): string[]`.
 * - Plan: a `TaskExecutionPlan<T>` computed by `executionPlan(tasks)`.
 * - Section stack: the array of previously completed task frames passed to the
 *   executor to enable contextual or incremental behavior.
 *
 * Performance notes:
 * - Planning is O(V + E) over the existing-dependency edges.
 * - Execution is O(V + E) with stable sorting limited to the frontier.
 *
 * Example
 * ```ts
 * type MyTask = {
 *   taskId: () => string;
 *   taskDeps: () => string[];
 *   run: () => Promise<void>;
 * };
 *
 * const tasks: MyTask[] = [
 *   { taskId: () => "build", taskDeps: () => ["clean"], run: async () => {} },
 *   { taskId: () => "clean", taskDeps: () => [],            run: async () => {} },
 * ];
 *
 * const plan = executionPlan(tasks);
 *
 * const summary = await executeDAG(plan, async (task, section) => {
 *   try {
 *     await task.run();
 *     return {
 *       disposition: "continue",
 *       ...{
 *         ctx: { runId: "demo" },
 *         success: true,
 *         exitCode: 0,
 *         startedAt: new Date(),
 *         endedAt: new Date(),
 *       },
 *     };
 *   } catch (error) {
 *     return {
 *       disposition: "terminate",
 *       ...{
 *         ctx: { runId: "demo" },
 *         success: false,
 *         exitCode: 1,
 *         error,
 *         startedAt: new Date(),
 *         endedAt: new Date(),
 *       },
 *     };
 *   }
 * });
 * ```
 */
import {
  bold,
  cyan,
  dim,
  gray,
  green,
  magenta,
  red,
  yellow,
} from "jsr:@std/fmt@1/colors";
import { eventBus } from "../universal/event-bus.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type Task = {
  taskId: () => string;
  taskDeps?: () => string[] | undefined;
};

export interface TaskExecutionPlan<T extends Task> {
  /** Tasks in the order they were defined in the notebook */
  readonly tasks: readonly T[];
  /** Task identities in definition order (convenience) */
  readonly ids: readonly string[];
  /** Quick lookup by id */
  readonly byId: Readonly<Record<string, T>>;
  /** Declared deps that don’t exist as tasks (by task id) */
  readonly missingDeps: Readonly<Record<string, string[]>>;
  /** Adjacency: dep -> [tasks that depend on it] (existing deps only) */
  readonly adjacency: Readonly<Record<string, string[]>>;
  /** In-degree per node considering only existing deps */
  readonly indegree: Readonly<Record<string, number>>;
  /** All edges (dep -> task) for existing deps, definition-order stable */
  readonly edges: readonly [string, string][];
  /**
   * Kahn “waves” (levels). Each inner array lists task ids that
   * can run in parallel at that level (all prereqs satisfied).
   */
  readonly layers: readonly string[][];
  /** Tasks in computed execution order (topological; respects deps) */
  readonly dag: readonly T[];
  /**
   * Nodes left with in-degree > 0 after Kahn’s algorithm.
   * Non-empty means a cycle or unmet dependency chain.
   */
  readonly unresolved: readonly string[];
}

/**
 * Build a deterministic execution plan for a set of tasks.
 *
 * Uses Kahn’s algorithm to compute:
 * - `layers`: “waves” of ids that can run together (all prereqs satisfied)
 * - `dag`: topological order when the graph is acyclic
 * - `unresolved`: ids that could not be scheduled (cycles or unmet chains)
 *
 * Additional views are included for diagnostics and scheduling:
 * - `ids`: task ids in definition order
 * - `byId`: id → task lookup
 * - `missingDeps`: task id → declared deps that are not present as tasks
 * - `adjacency`: dep → [tasks that depend on it] (existing deps only)
 * - `indegree`: original indegree snapshot (non-destructive)
 * - `edges`: list of (dep, task) edges in definition-stable order
 *
 * Dependency handling:
 * - Each task’s dependency list is normalized to preserve first occurrence and
 *   remove duplicates.
 * - Missing dependencies are recorded in `missingDeps` and excluded from the
 *   edge set (preventing accidental indegree inflation).
 *
 * Determinism:
 * - Zero-indegree frontiers are ordered by original definition index to keep
 *   `layers` and `dag` stable between runs given identical inputs.
 *
 * Complexity:
 * - O(V + E) where E counts only edges connecting tasks that exist in `byId`.
 *
 * @template T extends Task
 * @param tasks Tasks in definition order.
 * @returns A complete `TaskExecutionPlan<T>` with graph views, layers, and topo.
 *
 * @example
 * const plan = executionPlan(tasks);
 * console.log(plan.layers);       // [['clean'], ['build']]
 * console.log(plan.unresolved);   // [] if acyclic
 * console.log(plan.missingDeps);  // { build: ['unknown-dep'] } if any
 */
export function executionPlan<T extends Task>(
  tasks: T[],
): TaskExecutionPlan<T> {
  // Index, ids, and lookup
  const ids = tasks.map((t) => t.taskId());
  const byId: Record<string, T> = Object.fromEntries(
    tasks.map((t) => [t.taskId(), t] as const),
  );

  // Normalize deps per task (keep order, dedupe while preserving first occurrence)
  const normDeps: Record<string, string[]> = {};
  for (const task of tasks) {
    const id = task.taskId();
    const raw = task.taskDeps?.() ?? [];
    const seen = new Set<string>();
    const list: string[] = [];
    for (const d of raw) {
      if (!seen.has(d)) {
        seen.add(d);
        list.push(d);
      }
    }
    normDeps[id] = list;
  }

  // Missing deps (declared but not defined as tasks)
  const missingDeps: Record<string, string[]> = {};
  for (const id of ids) {
    const miss = normDeps[id].filter((d) => !(d in byId));
    if (miss.length) missingDeps[id] = miss;
  }

  // Build graph using only existing deps: edge (dep) -> (task)
  const adjacency: Record<string, string[]> = {};
  const indegreeSnapshot: Record<string, number> = {}; // FIX: snapshot container
  for (const id of ids) {
    adjacency[id] = [];
    indegreeSnapshot[id] = 0;
  }

  const edges: [string, string][] = [];
  // Preserve definition-order stability: iterate tasks in order, deps in listed order
  for (const taskId of ids) {
    for (const dep of normDeps[taskId]) {
      if (!(dep in byId)) continue; // skip missing
      adjacency[dep].push(taskId);
      indegreeSnapshot[taskId] += 1; // FIX: count only in snapshot
      edges.push([dep, taskId]);
    }
  }

  // ----- Kahn’s algorithm with definition-order tie breaking
  // FIX: work on a *copy* so snapshot stays pristine
  const indegWork: Record<string, number> = { ...indegreeSnapshot };

  const zeroQueue: string[] = ids.filter((id) => indegWork[id] === 0);
  const layers: string[][] = [];
  const topo: string[] = [];

  // Process in “waves” to expose natural parallelism
  while (zeroQueue.length) {
    const wave = [...zeroQueue];
    layers.push(wave);
    zeroQueue.length = 0;

    for (const u of wave) {
      topo.push(u);
      for (const v of adjacency[u]) {
        indegWork[v] -= 1; // FIX: decrement the work copy
        if (indegWork[v] === 0) zeroQueue.push(v);
      }
      // Keep new zeros stable by original definition order
      zeroQueue.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
    }
  }

  // Any node not in topo has unresolved in-degree (cycle or blocked chain)
  const inTopo = new Set(topo);
  const unresolved = ids.filter((id) => !inTopo.has(id));

  // Map topological ids back to TaskCells (ignore unresolved)
  const dag = topo.map((id) => byId[id]);

  return {
    tasks,
    ids,
    byId,
    missingDeps,
    adjacency,
    indegree: indegreeSnapshot, // FIX: return the original snapshot
    edges,
    layers,
    dag,
    unresolved,
  };
}

/** Derive a TaskExecutionPlan<T> induced by targets ∪ their transitive ancestors. */

export function executionSubplan<T extends Task>(
  plan: TaskExecutionPlan<T>,
  only: Iterable<string>,
): TaskExecutionPlan<T> {
  // Build parent index once (child -> parents)
  const parents = new Map<string, string[]>();
  for (const id of plan.ids) parents.set(id, []);
  for (const [dep, child] of plan.edges) parents.get(child)!.push(dep);

  // Ancestor closure (ignore unknown targets safely)
  const want = new Set(only);
  const selected = new Set<string>();
  const stack: string[] = [];
  for (const t of want) if (t in plan.byId) stack.push(t);
  while (stack.length) {
    const cur = stack.pop()!;
    if (selected.has(cur)) continue;
    selected.add(cur);
    for (const p of (parents.get(cur) ?? [])) stack.push(p);
  }

  // Induced plan structures, preserving original definition order
  const ids = plan.ids.filter((id) => selected.has(id));
  const byId: Record<string, T> = Object.fromEntries(
    ids.map((id) => [id, plan.byId[id]] as const),
  );

  const adjacency: Record<string, string[]> = {};
  const indegree: Record<string, number> = {};
  for (const id of ids) {
    adjacency[id] = [];
    indegree[id] = 0;
  }

  const edges: [string, string][] = [];
  for (const [dep, child] of plan.edges) {
    if (selected.has(dep) && selected.has(child)) {
      adjacency[dep].push(child);
      indegree[child] += 1;
      edges.push([dep, child]);
    }
  }

  // Kahn on the induced subgraph (stable by original definition order)
  const indegWork = { ...indegree };
  const zeroQueue: string[] = ids.filter((id) => indegWork[id] === 0);
  const layers: string[][] = [];
  const topo: string[] = [];
  while (zeroQueue.length) {
    const wave = [...zeroQueue];
    layers.push(wave);
    zeroQueue.length = 0;
    for (const u of wave) {
      topo.push(u);
      for (const v of adjacency[u]) {
        indegWork[v] -= 1;
        if (indegWork[v] === 0) zeroQueue.push(v);
      }
      zeroQueue.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
    }
  }
  const inTopo = new Set(topo);
  const unresolved = ids.filter((id) => !inTopo.has(id));
  const dag = topo.map((id) => byId[id]);

  // Filter missing deps to selected nodes only (signal, not noise)
  const missingDeps = Object.fromEntries(
    Object.entries(plan.missingDeps).filter(([id]) => selected.has(id)),
  );

  return {
    tasks: ids.map((id) => byId[id]),
    ids,
    byId,
    missingDeps,
    adjacency,
    indegree,
    edges,
    layers,
    dag,
    unresolved,
  };
}

/* ========================
 * Result & event types
 * ======================== */

export type TaskExecutionResult<
  Context,
  StdOut = Uint8Array,
  StdErr = Uint8Array,
> =
  & {
    ctx: Context;
    success: boolean;
    exitCode: number;
    startedAt: Date;
    endedAt: Date;
  }
  & ({ success: true; stdout?: () => StdOut } | {
    success: false;
    stderr?: () => StdErr;
    error?: unknown;
  });

/** Only the events we actually emit in this file. */
export type TaskExecEventMap<T extends Task, Context> = {
  "run:start": {
    ctx: Context;
    plan: TaskExecutionPlan<T>;
    startedAt: Date;
  };
  "plan:ready": {
    ctx: Context;
    ids: readonly string[];
    unresolved: readonly string[];
    missingDeps: Readonly<Record<string, string[]>>;
  };
  "dag:ready": { ctx: Context; ids: readonly string[] };
  "dag:release": { ctx: Context; from: string; to: readonly string[] };
  "task:scheduled": { ctx: Context; id: string };
  "task:start": {
    ctx: Context;
    id: string;
    task: T;
    at: Date;
  };
  "task:end": {
    ctx: Context;
    id: string;
    result: TaskExecutionResult<Context>;
  };
  "run:end": {
    ctx: Context;
    endedAt: Date;
    durationMs: number;
    totals: {
      tasks: number;
      failed: number;
      succeeded: number;
      unresolved: number;
      missingDeps: number;
    };
  };
  error: {
    message: string;
    cause?: unknown;
    taskId?: string;
    stage?:
      | "plan"
      | "schedule"
      | "task-start"
      | "task-run"
      | "task-end"
      | "finalize";
  };
};

export type ContinueOrTerminate = "continue" | "terminate";

/** One completed execution in the section stack. */
export type SectionFrame<T extends Task, Context> = {
  taskId: string;
  task: T;
  result: TaskExecutionResult<Context>;
};

/** Read-only view passed to the executor. */
export type SectionStack<T extends Task, Context> = readonly SectionFrame<
  T,
  Context
>[]; // <- as before

export interface ExecuteSummary<T extends Task, Context> {
  ran: readonly string[];
  terminated: boolean;
  section: ReadonlyArray<SectionFrame<T, Context>>;
}

/* ========================
 * Internals
 * ======================== */

type MaybeBus<T extends Task, C> =
  | ReturnType<typeof eventBus<TaskExecEventMap<T, C>>>
  | undefined;

function makeResult<Context>(
  ctx: Context,
  ok: true | false,
  extra?:
    & Partial<Omit<TaskExecutionResult<Context>, "ok" | "ctx">>
    & { error?: unknown },
): TaskExecutionResult<Context> {
  const now = new Date();
  return {
    ctx,
    success: ok,
    exitCode: ok ? 0 : (extra?.exitCode ?? 1),
    startedAt: extra?.startedAt ?? now,
    endedAt: extra?.endedAt ?? now,
    ...(ok ? {} : { error: extra?.error }),
  } as TaskExecutionResult<Context>;
}

function defaultCtx(): { runId: string } {
  const runId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `run-${Math.random().toString(36).slice(2)}`;
  return { runId };
}

/**
 * Execute a previously planned DAG in deterministic, serial order.
 *
 * Scheduling:
 * - Seeds the ready queue with zero-indegree task ids using `plan.indegree`.
 * - Always picks the next id by original definition rank for stable behavior.
 * - After each completion, decrements successors’ indegree and releases any
 *   that reach zero, again maintaining stable ordering.
 *
 * Execution contract:
 * - You supply an async `execute(task, section)` that returns a full
 *   `TaskExecutionResult<Context>` plus a `disposition` of `"continue"` or
 *   `"terminate"`. Returning `"terminate"` stops further scheduling immediately.
 * - The `section` argument is the completed stack (read-only view) containing
 *   frames `{ taskId, task, result }`, enabling incremental or dependent logic.
 *
 * Context:
 * - If no `ctx` is provided, a default `{ runId }` is created.
 *
 * Events (optional):
 * - If an `eventBus` created via `eventBus<TaskExecEventMap<T, Context>>()` is
 *   provided, the executor emits:
 *   - "run:start"         — run begins with plan and timestamp
 *   - "plan:ready"        — ids, unresolved, and missingDeps announced
 *   - "dag:ready"         — initial ready queue
 *   - "task:scheduled"    — task id scheduled
 *   - "task:start"        — task about to execute
 *   - "task:end"          — task finished with its result
 *   - "dag:release"       — successors released by a completed task
 *   - "run:end"           — final tallies and duration
 *   - "error"             — thrown error during task execution (synthesizes a
 *                           failing result and terminates)
 *
 * Failure behavior:
 * - If `execute` throws, a failing result is synthesized, an "error" event is
 *   emitted, and execution terminates.
 *
 * Returns:
 * - `ran`: ids in the order they were executed
 * - `terminated`: whether execution ended early due to disposition or error
 * - `section`: final read-only stack of completed frames
 *
 * @template T extends Task
 * @template Context
 * @param plan A `TaskExecutionPlan<T>` returned by `executionPlan()`.
 * @param execute User-supplied async runner for a single task.
 * @param init Optional `{ eventBus, ctx }`.
 * @returns Summary with `ran`, `terminated`, and `section` frames.
 *
 * @example
 * const summary = await executeDAG(plan, async (task, section) => {
 *   const startedAt = new Date();
 *   try {
 *     await task.run();
 *     return {
 *       disposition: "continue",
 *       ctx: { runId: "demo" },
 *       success: true,
 *       exitCode: 0,
 *       startedAt,
 *       endedAt: new Date(),
 *     };
 *   } catch (error) {
 *     return {
 *       disposition: "terminate",
 *       ctx: { runId: "demo" },
 *       success: false,
 *       exitCode: 1,
 *       error,
 *       startedAt,
 *       endedAt: new Date(),
 *     };
 *   }
 * });
 */
export async function executeDAG<T extends Task, Context = { runId: string }>(
  plan: TaskExecutionPlan<T>,
  execute: (
    task: T,
    ctx: Context,
    section: SectionStack<T, Context>,
  ) =>
    | TaskExecutionResult<Context> & { disposition: ContinueOrTerminate }
    | Promise<
      TaskExecutionResult<Context> & { disposition: ContinueOrTerminate }
    >,
  init?: { eventBus?: MaybeBus<T, Context>; ctx?: Context },
): Promise<ExecuteSummary<T, Context>> {
  const bus = init?.eventBus;
  const ctx = init?.ctx ?? (defaultCtx() as Context);
  const startedAt = new Date();
  const missingDepsCount = Object.keys(plan.missingDeps).length;

  const ran: string[] = [];
  const section: SectionFrame<T, Context>[] = [];

  bus?.emit("run:start", { ctx, plan, startedAt });
  bus?.emit("plan:ready", {
    ctx,
    ids: plan.ids,
    unresolved: plan.unresolved,
    missingDeps: plan.missingDeps,
  });

  // ---- Hardened, deterministic scheduling (stable by definition order)
  const rank = new Map(plan.ids.map((id, i) => [id, i] as const));

  // Seed indegrees for all ids (default 0 if missing)
  const indeg: Record<string, number> = Object.fromEntries(
    plan.ids.map((id) => [id, plan.indegree[id] ?? 0]),
  );

  const ready: string[] = [];
  const pushReady = (id: string) => {
    ready.push(id);
    ready.sort((a, b) => (rank.get(a)! - rank.get(b)!));
  };
  for (const id of plan.ids) {
    if ((indeg[id] ?? 0) === 0) pushReady(id);
  }

  bus?.emit("dag:ready", { ctx, ids: ready });

  let terminated = false;

  while (ready.length && !terminated) {
    const id = ready.shift();
    if (!id) break;

    const task = plan.byId[id];
    bus?.emit("task:scheduled", { ctx, id });
    bus?.emit("task:start", { ctx, id, task, at: new Date() });

    try {
      // NEW: caller returns a full TaskExecutionResult with a disposition
      const { disposition, ...result } = await execute(
        task,
        ctx,
        section as SectionStack<T, Context>,
      );

      // Record + emit using the caller-provided result
      ran.push(id);
      bus?.emit("task:end", { ctx, id, result });
      section.push({ taskId: id, task, result });

      if (disposition === "terminate") {
        terminated = true;
        break;
      }

      // Release successors with defensive defaults
      const released: string[] = [];
      const succ = plan.adjacency[id] ?? [];
      for (const nxt of succ) {
        const nextDeg = (indeg[nxt] = (indeg[nxt] ?? 0) - 1);
        if (nextDeg === 0) {
          pushReady(nxt);
          released.push(nxt);
        }
      }
      if (released.length) {
        bus?.emit("dag:release", { ctx, from: id, to: released });
      }
    } catch (cause) {
      // On throw, synthesize a failing result and terminate
      const result = makeResult(ctx, false, { error: cause });
      bus?.emit("task:end", { ctx, id, result });
      section.push({ taskId: id, task, result });

      bus?.emit("error", {
        message: "Task threw during execution",
        cause,
        taskId: id,
        stage: "task-run",
      });
      terminated = true;
      break;
    }
  }

  const endedAt = new Date();
  const failedCount = section.filter((f) => !f.result.success).length;

  bus?.emit("run:end", {
    ctx,
    endedAt,
    durationMs: endedAt.getTime() - startedAt.getTime(),
    totals: {
      tasks: section.length,
      failed: failedCount,
      succeeded: section.length - failedCount,
      unresolved: plan.unresolved.length,
      missingDeps: missingDepsCount,
    },
  });

  return { ran, terminated, section };
}

/* ========================
 * Polymorphic Task Executor (builder + DX helpers)
 * ======================== */

/** The execute function type, derived from executeDAG’s second parameter. */
export type ExecutorOf<T extends Task, Context> = Parameters<
  typeof executeDAG<T, Context>
>[1];

/** The result type returned by an ExecutorOf (awaited). */
export type ExecResultOf<T extends Task, Context> = Awaited<
  ReturnType<ExecutorOf<T, Context>>
>;

/** Cross-cutting middleware for an executor. */
export type ExecuteMiddleware<T extends Task, Context> = (
  next: ExecutorOf<T, Context>,
) => ExecutorOf<T, Context>;

/** Compose middlewares (last registered is outermost). */
export function composeMiddlewares<T extends Task, Context>(
  base: ExecutorOf<T, Context>,
  middlewares: readonly ExecuteMiddleware<T, Context>[],
): ExecutorOf<T, Context> {
  let fn = base;
  for (let i = middlewares.length - 1; i >= 0; i--) fn = middlewares[i](fn);
  return fn;
}

/** A type-guarded handler that knows how to execute a subset of tasks. */
export interface TaskHandler<T extends Task, U extends T, Context> {
  matches(task: T): task is U;
  run(
    task: U,
    ctx: Context,
    section: SectionStack<T, Context>,
  ): ExecResultOf<T, Context> | Promise<ExecResultOf<T, Context>>;
}

/** Builder for a polymorphic task executor. */
export class TaskExecutorBuilder<T extends Task, Context> {
  private handlers: Array<TaskHandler<T, T, Context>> = [];
  private middlewares: ExecuteMiddleware<T, Context>[] = [];
  private onUnknown?: TaskHandler<T, T, Context>;

  handle<U extends T>(
    matches: (task: T) => task is U,
    run: TaskHandler<T, U, Context>["run"],
  ): this {
    // Wrap `run` so we can store a unified handler type without `any`
    const wrapped: TaskHandler<T, T, Context> = {
      matches: (task: T): task is T => matches(task),
      run: async (task: T, ctx: Context, section: SectionStack<T, Context>) => {
        // task is U here by virtue of matches
        return await run(task as unknown as U, ctx, section);
      },
    };
    this.handlers.push(wrapped);
    return this;
  }

  /** Optional fallback if no handler matches. */
  fallback(run: TaskHandler<T, T, Context>["run"]): this {
    this.onUnknown = { matches: (_): _ is T => true, run };
    return this;
  }

  /** Add cross-cutting middleware (logging, timing, retries, etc.). */
  use(mw: ExecuteMiddleware<T, Context>): this {
    this.middlewares.push(mw);
    return this;
  }

  /** Produce the final ExecuteFn to pass to executeDAG. */
  build(): ExecutorOf<T, Context> {
    // prefer-const + satisfy require-await by awaiting handler calls
    const base: ExecutorOf<T, Context> = async (task, ctx, section) => {
      for (const h of this.handlers) {
        if (h.matches(task)) {
          return await h.run(task, ctx, section);
        }
      }
      if (this.onUnknown) return await this.onUnknown.run(task, ctx, section);
      const now = new Date();
      return {
        disposition: "terminate" as ContinueOrTerminate,
        ctx,
        success: false,
        exitCode: 1,
        error: new Error(
          `No handler registered for task id "${task.taskId()}"`,
        ),
        startedAt: now,
        endedAt: now,
      };
    };
    return composeMiddlewares(base, this.middlewares);
  }
}

/* ---------- DX: type-guard helpers ---------- */

/** Create a type guard that matches by discriminant `kind`. */
export function matchKind<K extends string, U extends Task & { kind: K }>(
  kind: K,
): (t: Task) => t is U {
  return ((t: Task): t is U => (t as Any)?.kind === kind);
}

/** Match on a property with a predicate (guards when predicate returns true). */
export function matchProp<
  K extends string,
  V,
  U extends Task & Record<K, V>,
>(
  prop: K,
  predicate: (value: unknown) => value is V,
): (t: Task) => t is U {
  return ((t: Task): t is U => predicate((t as Any)?.[prop]));
}

/** Narrow by `instanceof` for object-bearing tasks. */
export function matchInstanceOf<
  C extends new (...args: Any[]) => Any,
  U extends Task,
>(
  prop: string,
  ctor: C,
): (t: Task) => t is U {
  return ((t: Task): t is U => (t as Any)?.[prop] instanceof ctor);
}

/* ---------- DX: result helpers (standardize ok/fail) ---------- */

// BEFORE: (the version that used Partial<Omit<...>>)
// export function ok<...>(..., extra?: Partial<Omit<TaskExecutionResult<...>>> & { disposition?: ... })

// AFTER:
export function ok<T extends Task, Context>(
  ctx: Context,
  extra?: {
    exitCode?: number;
    startedAt?: Date;
    endedAt?: Date;
    /** Optional producer for stdout on success (default encoding is fine). */
    stdout?: () => Uint8Array;
    disposition?: ContinueOrTerminate;
  },
): ExecResultOf<T, Context> {
  const now = new Date();
  return {
    disposition: extra?.disposition ?? "continue",
    ctx,
    success: true,
    exitCode: extra?.exitCode ?? 0,
    startedAt: extra?.startedAt ?? now,
    endedAt: extra?.endedAt ?? now,
    stdout: extra?.stdout,
  } as ExecResultOf<T, Context>;
}

export function fail<T extends Task, Context>(
  ctx: Context,
  error: unknown,
  extra?: {
    exitCode?: number;
    startedAt?: Date;
    endedAt?: Date;
    /** Optional producer for stderr on failure. */
    stderr?: () => Uint8Array;
    disposition?: ContinueOrTerminate;
  },
): ExecResultOf<T, Context> {
  const now = new Date();
  return {
    disposition: extra?.disposition ?? "terminate",
    ctx,
    success: false,
    exitCode: extra?.exitCode ?? 1,
    startedAt: extra?.startedAt ?? now,
    endedAt: extra?.endedAt ?? now,
    error,
    stderr: extra?.stderr,
  } as ExecResultOf<T, Context>;
}
/* ---------- DX: common middleware ---------- */

/** Measure elapsed time; on failure, append a tiny stderr line with elapsed_ms. */
export function withTiming<T extends Task, Context>(): ExecuteMiddleware<
  T,
  Context
> {
  return (next) => async (task, ctx, section) => {
    const t0 = performance.now();
    const res = await next(task, ctx, section);
    const t1 = performance.now();
    if (!res.success) {
      const prev = res.stderr;
      res.stderr = () => {
        const enc = new TextEncoder();
        const line = enc.encode(`elapsed_ms=${(t1 - t0).toFixed(2)}`);
        if (!prev) return line;
        const p = prev();
        const out = new Uint8Array(p.length + 1 + line.length);
        out.set(p, 0);
        out.set(enc.encode("\n"), p.length);
        out.set(line, p.length + 1);
        return out;
      };
    }
    return res;
  };
}

/** Enforce a wall-clock timeout per task. */
export function withTimeout<T extends Task, Context>(
  ms: number,
  opts?: { onTimeoutDisposition?: ContinueOrTerminate; exitCode?: number },
): ExecuteMiddleware<T, Context> {
  const disposition = opts?.onTimeoutDisposition ?? "terminate";
  const exitCode = opts?.exitCode ?? 124;
  return (next) => async (task, ctx, section) => {
    const startedAt = new Date();
    let timer: number | undefined;
    try {
      const timeout = new Promise<ExecResultOf<T, Context>>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            disposition,
            ctx,
            success: false,
            exitCode,
            startedAt,
            endedAt: new Date(),
            error: new Error(`Task timed out after ${ms}ms`),
          } as ExecResultOf<T, Context>);
        }, ms) as unknown as number;
      });
      return await Promise.race([next(task, ctx, section), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer as unknown as number);
    }
  };
}

/** Retry failures with exponential backoff by default. */
export function withRetry<T extends Task, Context>(opts?: {
  retries?: number;
  shouldRetry?: (e: unknown) => boolean;
  backoffMs?: (attempt: number) => number; // attempt starts at 1
  continueOnFinalFail?: boolean;
}): ExecuteMiddleware<T, Context> {
  const retries = Math.max(0, opts?.retries ?? 2);
  const shouldRetry = opts?.shouldRetry ?? ((e) => e instanceof Error);
  const backoffMs = opts?.backoffMs ?? ((a) => 100 * Math.pow(2, a));
  const continueOnFinalFail = opts?.continueOnFinalFail ?? false;

  return (next) => async (task, ctx, section) => {
    const startedAt = new Date();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await next(task, ctx, section);
        if (res.success) return res;
        lastErr = res.error ??
          new Error(`Task failed (exitCode=${res.exitCode})`);
        if (attempt === retries || !shouldRetry(lastErr)) return res;
      } catch (err) {
        lastErr = err;
        if (attempt === retries || !shouldRetry(err)) {
          return fail<T, Context>(ctx, err, {
            startedAt,
            endedAt: new Date(),
            disposition: continueOnFinalFail ? "continue" : "terminate",
          });
        }
      }
      await new Promise((r) => setTimeout(r, backoffMs(attempt + 1)));
    }
    return fail<T, Context>(ctx, lastErr, { startedAt, endedAt: new Date() });
  };
}

/** Tiny DSL to create an executor from route list + middlewares + fallback. */
export function createExecutor<T extends Task, Context>(init: {
  routes: Array<{
    guard: (task: T) => boolean;
    run: ExecutorOf<T, Context>;
  }>;
  middlewares?: readonly ExecuteMiddleware<T, Context>[];
  fallback?: TaskHandler<T, T, Context>["run"];
}): ExecutorOf<T, Context> {
  const b = new TaskExecutorBuilder<T, Context>();
  for (const r of init.routes) {
    // Wrap the non-narrowing guard with a generic handler
    b.handle<T>((t: T): t is T => r.guard(t), r.run);
  }
  if (init.fallback) b.fallback(init.fallback);
  for (const mw of (init.middlewares ?? [])) b.use(mw);
  return b.build();
}

/**
 * Create a verbose, single-line logging bus for Task execution.
 *
 * Pass this bus into whatever runs your Task engine so it can emit TaskExecEventMap<T, C> events.
 */
export function verboseInfoTaskEventBus<
  T extends Task,
  Context,
>(init: {
  style: "plain" | "rich";
  /** Max IDs to show inline before summarizing, default 10 */
  showIdsMax?: number;
}) {
  const fancy = init.style === "rich";
  const maxShow = init.showIdsMax ?? 10;
  const bus = eventBus<TaskExecEventMap<T, Context>>();

  // Emojis
  const E = {
    run: "🏃",
    graph: "📈",
    link: "🔗",
    play: "▶️",
    stop: "⏹️",
    check: "✅",
    cross: "❌",
    warn: "⚠️",
    err: "💥",
    box: "📦",
    gear: "⚙️",
    timer: "⏱️",
    list: "📝",
  } as const;

  // Colors
  const c = {
    tag: (s: string) => (fancy ? bold(magenta(s)) : s),
    id: (s: string) => (fancy ? bold(cyan(s)) : s),
    ok: (s: string) => (fancy ? green(s) : s),
    warn: (s: string) => (fancy ? yellow(s) : s),
    err: (s: string) => (fancy ? red(s) : s),
    faint: (s: string) => (fancy ? dim(s) : s),
    gray: (s: string) => (fancy ? gray(s) : s),
  };

  // Emoji helpers
  const em = {
    run: (s: string) => (fancy ? `${E.run} ${s}` : s),
    graph: (s: string) => (fancy ? `${E.graph} ${s}` : s),
    link: (s: string) => (fancy ? `${E.link} ${s}` : s),
    play: (s: string) => (fancy ? `${E.play} ${s}` : s),
    stop: (s: string) => (fancy ? `${E.stop} ${s}` : s),
    done: (
      ok: boolean,
    ) => (fancy ? (ok ? E.check : E.cross) : ok ? "OK" : "FAIL"),
    warn: (s: string) => (fancy ? `${E.warn} ${s}` : s),
    err: (s: string) => (fancy ? `${E.err} ${s}` : s),
    timer: (ms?: number) =>
      ms == null
        ? ""
        : fancy
        ? ` ${E.timer} ${Math.round(ms)}ms`
        : ` ${Math.round(ms)}ms`,
    list: (s: string) => (fancy ? `${E.list} ${s}` : s),
    gear: (s: string) => (fancy ? `${E.gear} ${s}` : s),
    box: (s: string) => (fancy ? `${E.box} ${s}` : s),
  };

  // Formatters
  const fmtIds = (ids: readonly string[]) => {
    if (ids.length <= maxShow) return ids.join(", ");
    return `${ids.slice(0, maxShow).join(", ")}${
      c.faint(` …(+${ids.length - maxShow})`)
    }`;
  };
  const fmtPairs = (obj: Record<string, unknown>) =>
    Object.entries(obj)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
  const fmtTotals = (t: {
    tasks: number;
    failed: number;
    succeeded: number;
    unresolved: number;
    missingDeps: number;
  }) =>
    `tasks=${t.tasks} ${c.ok(`ok=${t.succeeded}`)} ${
      c.err(`fail=${t.failed}`)
    } ` +
    `${c.warn(`unresolved=${t.unresolved}`)} missingDeps=${t.missingDeps}`;

  // ---- listeners ----
  bus.on("run:start", ({ startedAt }) => {
    console.info(
      `${c.tag("[run]")} ${em.run("start")} ${
        c.faint(startedAt.toISOString())
      }`,
    );
  });

  bus.on("plan:ready", ({ ids, unresolved, missingDeps }) => {
    const parts = [
      `${em.box("plan")}`,
      `ids=${ids.length}`,
      unresolved.length
        ? c.warn(`unresolved=${unresolved.length}`)
        : c.ok("unresolved=0"),
      Object.keys(missingDeps).length
        ? c.warn(`missingDeps=${Object.keys(missingDeps).length}`)
        : "missingDeps=0",
    ];
    console.info(`${c.tag("[plan]")} ${parts.join(" ")}`);
    if (ids.length) {
      console.info(`${c.tag("[plan]")} ${em.list("ids")} ${fmtIds(ids)}`);
    }
    if (unresolved.length) {
      console.info(
        `${c.tag("[plan]")} ${em.list(c.warn("unresolved"))} ${
          fmtIds(unresolved)
        }`,
      );
    }
    const mdKeys = Object.keys(missingDeps);
    if (mdKeys.length) {
      for (const k of mdKeys) {
        console.info(
          `${c.tag("[plan]")} ${em.link(`${c.id(k)} ->`)} ${
            fmtIds(missingDeps[k])
          }`,
        );
      }
    }
  });

  bus.on("dag:ready", ({ ids }) => {
    console.info(
      `${c.tag("[dag]")} ${em.graph("ready")} nodes=${ids.length}` +
        (ids.length ? ` ${c.faint(fmtIds(ids))}` : ""),
    );
  });

  bus.on("dag:release", ({ from, to }) => {
    console.info(
      `${c.tag("[dag]")} ${em.link(`${c.id(from)} →`)} ${fmtIds(to)}`,
    );
  });

  bus.on("task:scheduled", ({ id }) => {
    console.info(`${c.tag("[task]")} ${em.gear("scheduled")} ${c.id(id)}`);
  });

  bus.on("task:start", ({ id, at }) => {
    console.info(
      `${c.tag("[task]")} ${em.play("start")} ${c.id(id)} ${
        c.faint(at.toISOString())
      }`,
    );
  });

  bus.on("task:end", ({ id, result }) => {
    const line = `${c.tag("[task]")} ${em.stop("end")} ${c.id(id)} ` +
      (result.success ? c.ok("success") : c.err("failure"));
    // If your result includes timing, stderr, exitCode, etc., summarize them:
    const extras: Record<string, unknown> = {
      // deno-lint-ignore no-explicit-any
      code: (result as any).exitCode ?? (result as any).code, // tolerate either field name
      // deno-lint-ignore no-explicit-any
      startedAt: (result as any).startedAt?.toISOString?.(),
      // deno-lint-ignore no-explicit-any
      endedAt: (result as any).endedAt?.toISOString?.(),
    };
    const extraText = fmtPairs(
      Object.fromEntries(Object.entries(extras).filter(([, v]) => v != null)),
    );
    console.info(extraText ? `${line} ${c.faint(extraText)}` : line);
  });

  bus.on("run:end", ({ endedAt, durationMs, totals }) => {
    const head = `${c.tag("[run]")} ${em.stop("end")} ${
      c.faint(endedAt.toISOString())
    }`;
    console.info(`${head} ${fmtTotals(totals)}${em.timer(durationMs)}`);
  });

  bus.on("error", ({ message, cause, taskId, stage }) => {
    const parts = [
      c.err(message),
      taskId ? `task=${c.id(taskId)}` : "",
      stage ? `stage=${stage}` : "",
    ].filter(Boolean);
    const suffix = cause instanceof Error
      ? ` cause=${c.faint(cause.name)}:${c.faint(cause.message)}`
      : cause != null
      ? ` cause=${c.faint(String(cause))}`
      : "";
    console.error(`${c.tag("[error]")} ${em.err(parts.join(" "))}${suffix}`);
  });

  return bus;
}

/**
 * Create a minimal logging bus that only prints errors.
 *
 * - Listens to `"task:end"` and prints a line **only** when `result.success === false`.
 * - Also listens to top-level `"error"` events (thrown during execution).
 * - When available, prints the `stderr()` payload (decoded as UTF-8) after the header line.
 *
 * Usage:
 *   const bus = errorOnlyTaskEventBus<{...}>({ style: "rich" });
 *   await executeDAG(plan, exec, { eventBus: bus, ctx });
 */
export function errorOnlyTaskEventBus<
  T extends Task,
  Context,
>(init: { style: "plain" | "rich" }) {
  const fancy = init.style === "rich";
  const bus = eventBus<TaskExecEventMap<T, Context>>();

  // Emojis (rich only)
  const E = {
    err: "💥",
    stop: "⏹️",
    cross: "❌",
    page: "📄",
  } as const;

  // Colors
  const c = {
    tag: (s: string) => (fancy ? bold(red(s)) : s),
    id: (s: string) => (fancy ? bold(cyan(s)) : s),
    err: (s: string) => (fancy ? red(s) : s),
    faint: (s: string) => (fancy ? dim(s) : s),
  };

  // Emoji helpers
  const em = {
    err: (s: string) => (fancy ? `${E.err} ${s}` : s),
    stop: (s: string) => (fancy ? `${E.stop} ${s}` : s),
    cross: (s: string) => (fancy ? `${E.cross} ${s}` : s),
    page: (s: string) => (fancy ? `${E.page} ${s}` : s),
  };

  const decode = (u?: Uint8Array) => {
    if (!u || !(u instanceof Uint8Array)) return undefined;
    try {
      return new TextDecoder().decode(u);
    } catch {
      return `<<${u.byteLength} bytes: non-UTF8>>`;
    }
  };

  const fmtPairs = (obj: Record<string, unknown>) =>
    Object.entries(obj)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");

  // Print only failing task completions
  bus.on("task:end", ({ id, result }) => {
    if (result.success) return;

    const header =
      `${c.tag("[task]")} ${em.stop(em.cross("fail"))} ${c.id(id)} ` +
      c.err(
        fmtPairs({
          code: (result as Any).exitCode, // tolerate field name
          startedAt: (result as Any).startedAt?.toISOString?.(),
          endedAt: (result as Any).endedAt?.toISOString?.(),
        }),
      );

    console.error(header);

    // If there’s stderr, print it on following lines
    const bytes = result.stderr?.();
    const text = decode(bytes);
    if (text && text.length) {
      const label = `${c.tag("[stderr]")} ${em.page("")}`;
      // Print multi-line stderr exactly as-is after a label line
      console.error(label);
      console.error(text);
    }

    // If there’s an Error object, include its name/message (stack left to caller)
    // deno-lint-ignore no-explicit-any
    const errObj = (result as any).error;
    if (errObj instanceof Error) {
      console.error(
        `${c.tag("[error]")} ${em.err(`${errObj.name}: ${errObj.message}`)}`,
      );
    } else if (errObj != null) {
      console.error(`${c.tag("[error]")} ${em.err(String(errObj))}`);
    }
  });

  // Print executor-level thrown errors
  bus.on("error", ({ message, cause, taskId, stage }) => {
    const line = `${c.tag("[error]")} ${em.err(message)} ` +
      fmtPairs({
        task: taskId ? c.id(taskId) : undefined,
        stage,
      });
    console.error(line);

    if (cause instanceof Error) {
      console.error(
        `${c.tag("[cause]")} ${em.err(`${cause.name}: ${cause.message}`)}`,
      );
      if (cause.stack) console.error(c.faint(cause.stack));
    } else if (cause != null) {
      console.error(`${c.tag("[cause]")} ${String(cause)}`);
    }
  });

  // Do NOT log plan/run events here — this bus is intentionally error-only
  return bus;
}
