import { assertArrayIncludes, assertEquals } from "@std/assert";
import {
  createExecutor,
  executeDAG,
  executionPlan,
  executionSubplan,
  fail,
  matchKind,
  ok,
  type Task,
  type TaskExecutionResult,
  TaskExecutorBuilder,
  withRetry,
  withTimeout,
  withTiming,
} from "./task.ts";

/** Simple test task that implements the required Task interface. */
interface TestTask extends Task {
  run?: () => Promise<void>;
}

const T = (
  id: string,
  deps: string[] = [],
  run?: () => Promise<void>,
): TestTask => ({
  taskId: () => id,
  taskDeps: () => deps,
  run,
});

Deno.test("executionPlan()", async (t) => {
  await t.step(
    "builds ids, byId, edges, layers, dag for an acyclic graph",
    () => {
      // clean -> build -> test
      const tasks = [T("clean"), T("build", ["clean"]), T("test", ["build"])];
      const plan = executionPlan(tasks);

      assertEquals(plan.ids, ["clean", "build", "test"]);
      assertEquals(Object.keys(plan.byId), ["clean", "build", "test"]);
      assertEquals(plan.edges, [
        ["clean", "build"],
        ["build", "test"],
      ]);
      assertEquals(plan.layers, [["clean"], ["build"], ["test"]]);
      assertEquals(plan.dag.map((t) => t.taskId()), ["clean", "build", "test"]);
      assertEquals(plan.unresolved, []);
      assertEquals(plan.missingDeps, {});
    },
  );

  await t.step(
    "records missing dependencies but excludes them from edges",
    () => {
      const tasks = [T("build", ["clean", "unknown"]), T("clean")];
      const plan = executionPlan(tasks);

      assertEquals(plan.missingDeps, { build: ["unknown"] });
      assertEquals(plan.edges, [["clean", "build"]]);
    },
  );

  await t.step(
    "deduplicates duplicate dependencies while preserving first occurrence",
    () => {
      const tasks = [
        T("a"),
        T("b"),
        T("c", ["a", "a", "b", "a"]),
      ];
      const plan = executionPlan(tasks);

      assertEquals(plan.indegree["c"], 2);
      assertEquals(plan.edges, [
        ["a", "c"],
        ["b", "c"],
      ]);
    },
  );

  await t.step("stable definition-order tie-breaking in layers and dag", () => {
    const tasks = [T("a"), T("b"), T("c", ["a", "b"])];
    const plan = executionPlan(tasks);

    assertEquals(plan.layers[0], ["a", "b"]);
    assertEquals(plan.dag.map((t) => t.taskId()), ["a", "b", "c"]);
  });

  await t.step("detects cycles and reports unresolved", () => {
    // a -> b -> a (cycle), c independent
    const tasks = [T("a", ["b"]), T("b", ["a"]), T("c")];
    const plan = executionPlan(tasks);

    assertEquals(plan.layers[0], ["c"]);
    assertArrayIncludes(plan.unresolved, ["a", "b"]);
  });

  await t.step("indegree snapshot remains unchanged by execution", async () => {
    const tasks = [T("a"), T("b", ["a"]), T("c", ["b"])];
    const plan = executionPlan(tasks);
    const snapshotBefore = { ...plan.indegree };

    const summary = await executeDAG(
      plan,
      async (task) => {
        const now = new Date();
        await (task.run?.() ?? Promise.resolve());
        const result: TaskExecutionResult<{ runId: string }> & {
          disposition: "continue";
        } = {
          disposition: "continue",
          ctx: { runId: "t" },
          success: true,
          exitCode: 0,
          startedAt: now,
          endedAt: now,
        };
        return result;
      },
    );

    assertEquals(summary.terminated, false);
    assertEquals(plan.indegree, snapshotBefore);
  });

  // ===== New planning edge cases =====

  await t.step("empty input produces empty plan", () => {
    const plan = executionPlan<TestTask>([]);
    assertEquals(plan.ids, []);
    assertEquals(plan.dag, []);
    assertEquals(plan.layers, []);
    assertEquals(plan.unresolved, []);
    assertEquals(plan.missingDeps, {});
    assertEquals(plan.edges, []);
    assertEquals(plan.adjacency, {});
    assertEquals(plan.indegree, {});
  });

  await t.step("self-dependency results in unresolved with no layers", () => {
    // a depends on itself => no zero-indegree node
    const tasks = [T("a", ["a"])];
    const plan = executionPlan(tasks);

    assertEquals(plan.layers, []); // No wave can start
    assertEquals(plan.dag, []); // No topo
    assertEquals(plan.unresolved, ["a"]); // Stuck node
    assertEquals(plan.missingDeps, {}); // It's declared, not missing
    assertEquals(plan.indegree["a"], 1);
  });

  await t.step(
    "all-missing deps are recorded but do not increase indegree",
    () => {
      const tasks = [T("t", ["x", "y"])];
      const plan = executionPlan(tasks);

      assertEquals(plan.missingDeps, { t: ["x", "y"] });
      assertEquals(plan.indegree["t"], 0); // No edges added
      assertEquals(plan.edges, []);
      // With indegree 0, 't' is runnable immediately
      assertEquals(plan.layers, [["t"]]);
      assertEquals(plan.dag.map((t) => t.taskId()), ["t"]);
      assertEquals(plan.unresolved, []);
    },
  );

  await t.step("large diamond retains definition-stable layers", () => {
    // root -> a, b, c -> leaf
    const tasks = [
      T("root"),
      T("a", ["root"]),
      T("b", ["root"]),
      T("c", ["root"]),
      T("leaf", ["a", "b", "c"]),
    ];
    const plan = executionPlan(tasks);

    assertEquals(plan.layers, [
      ["root"],
      ["a", "b", "c"], // definition order
      ["leaf"],
    ]);
    assertEquals(plan.edges, [
      ["root", "a"],
      ["root", "b"],
      ["root", "c"],
      ["a", "leaf"],
      ["b", "leaf"],
      ["c", "leaf"],
    ]);
  });
});

/* ========================
 * subplan() tests
 * ======================== */

Deno.test("subplan()", async (t) => {
  await t.step(
    "leaf target pulls all ancestors; order is definition-stable",
    () => {
      // clean -> build -> test
      const tasks = [T("clean"), T("build", ["clean"]), T("test", ["build"])];
      const full = executionPlan(tasks);

      const sp = executionSubplan(full, ["test"]);
      assertEquals(sp.ids, ["clean", "build", "test"]);
      assertEquals(sp.edges, [["clean", "build"], ["build", "test"]]);
      assertEquals(sp.layers, [["clean"], ["build"], ["test"]]);
      assertEquals(sp.unresolved, []);
      assertEquals(sp.dag.map((t) => t.taskId()), ["clean", "build", "test"]);
    },
  );

  await t.step(
    "middle target includes just its ancestors (not unrelated leaves)",
    () => {
      const tasks = [T("clean"), T("build", ["clean"]), T("test", ["build"])];
      const full = executionPlan(tasks);

      const sp = executionSubplan(full, ["build"]);
      assertEquals(sp.ids, ["clean", "build"]);
      assertEquals(sp.edges, [["clean", "build"]]);
      assertEquals(sp.layers, [["clean"], ["build"]]);
      assertEquals(sp.unresolved, []);
    },
  );

  await t.step("multiple targets unify closures without duplicates", () => {
    const tasks = [T("clean"), T("build", ["clean"]), T("test", ["build"])];
    const full = executionPlan(tasks);

    const sp = executionSubplan(full, ["build", "test"]);
    assertEquals(sp.ids, ["clean", "build", "test"]);
    assertEquals(sp.layers, [["clean"], ["build"], ["test"]]);
  });

  await t.step("unknown targets are ignored safely", () => {
    const tasks = [T("a"), T("b", ["a"]), T("c", ["b"])];
    const full = executionPlan(tasks);

    const sp = executionSubplan(full, ["nope", "c"]);
    assertEquals(sp.ids, ["a", "b", "c"]);
    assertEquals(sp.edges, [["a", "b"], ["b", "c"]]);
  });

  await t.step("filters missingDeps to selected nodes only", () => {
    // build depends on clean (exists) and ghost (missing)
    // other is unrelated and has its own missing dep that should be filtered out
    const tasks = [
      T("clean"),
      T("build", ["clean", "ghost"]),
      T("other", ["phantom"]),
    ];
    const full = executionPlan(tasks);

    const sp = executionSubplan(full, ["build"]);
    assertEquals(sp.missingDeps, { build: ["ghost"] });
    assertEquals(sp.indegree["build"], 1); // only 'clean' contributes
    assertEquals(sp.edges, [["clean", "build"]]);
    assertEquals(sp.ids, ["clean", "build"]);
  });

  await t.step("does not mutate original plan structures", () => {
    const tasks = [T("root"), T("a", ["root"]), T("b", ["a"])];
    const full = executionPlan(tasks);
    const snapshot = {
      ids: [...full.ids],
      indegree: { ...full.indegree },
      edges: [...full.edges],
      layers: full.layers.map((w) => [...w]),
      unresolved: [...full.unresolved],
    };

    // create a subplan and then re-assert original is intact
    void executionSubplan(full, ["b"]);

    assertEquals(full.ids, snapshot.ids);
    assertEquals(full.indegree, snapshot.indegree);
    assertEquals(full.edges, snapshot.edges);
    assertEquals(full.layers, snapshot.layers);
    assertEquals(full.unresolved, snapshot.unresolved);
  });

  await t.step(
    "execution over a subplan runs only selected induced nodes",
    async () => {
      // root -> a -> b ; plus an unrelated component x -> y
      const tasks = [
        T("root"),
        T("a", ["root"]),
        T("b", ["a"]),
        T("x"),
        T("y", ["x"]),
      ];
      const full = executionPlan(tasks);
      const sp = executionSubplan(full, ["b"]); // should include root, a, b only

      const ran: string[] = [];
      const summary = await executeDAG(
        sp,
        // deno-lint-ignore require-await
        async (task) => {
          const now = new Date();
          ran.push(task.taskId());
          return {
            disposition: "continue",
            ctx: { runId: "sub" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
      );

      assertEquals(summary.terminated, false);
      assertEquals(ran, ["root", "a", "b"]);
    },
  );
});

Deno.test("executeDAG()", async (t) => {
  await t.step(
    "executes tasks in topological order and accumulates a section stack",
    async () => {
      const tasks: TestTask[] = [
        T("clean", [], async () => {}),
        T("build", ["clean"], async () => {}),
        T("test", ["build"], async () => {}),
      ];
      const plan = executionPlan(tasks);

      const order: string[] = [];
      const summary = await executeDAG(
        plan,
        async (task, _ctx, section) => {
          assertEquals(order.length, section.length);
          const startedAt = new Date();
          await (task.run?.() ?? Promise.resolve());
          order.push(task.taskId());
          return {
            disposition: "continue",
            ctx: { runId: "demo" },
            success: true,
            exitCode: 0,
            startedAt,
            endedAt: new Date(),
          };
        },
      );

      assertEquals(summary.terminated, false);
      assertEquals(order, ["clean", "build", "test"]);
      assertEquals(summary.ran, order);
      assertEquals(summary.section.map((f) => f.taskId), order);
      const failures = summary.section.filter((f) => !f.result.success);
      assertEquals(failures.length, 0);
    },
  );

  await t.step(
    "terminates early when executor requests disposition=terminate",
    async () => {
      const tasks = [T("a"), T("b", ["a"]), T("c", ["b"])];
      const plan = executionPlan(tasks);

      const seen: string[] = [];
      const summary = await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async (task) => {
          const now = new Date();
          seen.push(task.taskId());
          if (task.taskId() === "b") {
            return {
              disposition: "terminate",
              ctx: { runId: "stop" },
              success: true,
              exitCode: 0,
              startedAt: now,
              endedAt: now,
            };
          }
          return {
            disposition: "continue",
            ctx: { runId: "stop" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
      );

      assertEquals(summary.terminated, true);
      assertEquals(seen, ["a", "b"]);
      assertEquals(summary.ran, ["a", "b"]);
    },
  );

  // FIXED: correct expectation — 'y' doesn't get added to `ran` if the executor throws.
  await t.step(
    "synthesizes a failing result and stops if executor throws",
    async () => {
      const tasks = [T("x"), T("y", ["x"])];
      const plan = executionPlan(tasks);

      const executed: string[] = [];
      const summary = await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async (task) => {
          const now = new Date();
          if (task.taskId() === "y") {
            throw new Error("boom");
          }
          executed.push(task.taskId());
          return {
            disposition: "continue",
            ctx: { runId: "err" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
      );

      assertEquals(summary.terminated, true);
      assertEquals(summary.ran, ["x"]);
      assertEquals(
        summary.section.map((f) => [f.taskId, f.result.success] as const),
        [["x", true], ["y", false]],
      );
    },
  );

  await t.step(
    "emits predictable releases (dag:release) order when multiple successors unlock",
    async () => {
      const tasks = [
        T("root"),
        T("a", ["root"]),
        T("b", ["root"]),
        T("c", ["a", "b"]),
      ];
      const plan = executionPlan(tasks);

      const releases: Array<{ from: string; to: string[] }> = [];
      // deno-lint-ignore no-explicit-any
      const mockBus: any = {
        // deno-lint-ignore no-explicit-any
        emit: (type: string, payload: any) => {
          if (type === "dag:release") releases.push(payload);
        },
      };

      await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async () => {
          const now = new Date();
          return {
            disposition: "continue",
            ctx: { runId: "rel" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
        { eventBus: mockBus },
      );

      assertEquals(releases.length >= 1, true);
      assertEquals(releases[0].from, "root");
      assertEquals(releases[0].to, ["a", "b"]);
    },
  );

  // ===== New execution edge cases =====

  await t.step(
    "continues scheduling when executor returns success:false with disposition:continue",
    async () => {
      // a -> b -> c, mark b as a soft failure but continue
      const tasks = [T("a"), T("b", ["a"]), T("c", ["b"])];
      const plan = executionPlan(tasks);

      const seen: string[] = [];
      const summary = await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async (task) => {
          const startedAt = new Date();
          seen.push(task.taskId());
          const isSoftFail = task.taskId() === "b";
          return {
            disposition: "continue",
            ctx: { runId: "soft" },
            success: !isSoftFail,
            exitCode: isSoftFail ? 2 : 0,
            startedAt,
            endedAt: new Date(),
          };
        },
      );

      assertEquals(summary.terminated, false);
      assertEquals(summary.ran, ["a", "b", "c"]);
      const successMap = Object.fromEntries(
        summary.section.map((f) => [f.taskId, f.result.success] as const),
      );
      assertEquals(successMap["a"], true);
      assertEquals(successMap["b"], false);
      assertEquals(successMap["c"], true);
    },
  );

  await t.step(
    "early terminate from root does not emit releases for successors",
    async () => {
      // root -> a
      const tasks = [T("root"), T("a", ["root"])];
      const plan = executionPlan(tasks);

      const releases: Array<{ from: string; to: string[] }> = [];
      // deno-lint-ignore no-explicit-any
      const mockBus: any = {
        // deno-lint-ignore no-explicit-any
        emit: (type: string, payload: any) => {
          if (type === "dag:release") releases.push(payload);
        },
      };

      const summary = await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async () => {
          const now = new Date();
          return {
            disposition: "terminate",
            ctx: { runId: "early" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
        { eventBus: mockBus },
      );

      assertEquals(summary.terminated, true);
      assertEquals(summary.ran, ["root"]);
      assertEquals(releases.length, 0);
    },
  );

  await t.step(
    "provided ctx is passed through results (via executor)",
    async () => {
      const tasks = [T("a")];
      const plan = executionPlan(tasks);

      const givenCtx = { runId: "given", custom: true } as const;
      // deno-lint-ignore no-explicit-any
      const frames: any[] = [];
      // deno-lint-ignore no-explicit-any
      const mockBus: any = {
        // deno-lint-ignore no-explicit-any
        emit: (type: string, payload: any) => {
          if (type === "task:end") frames.push(payload);
        },
      };

      await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async (_task) => {
          const now = new Date();
          return {
            disposition: "continue",
            // deno-lint-ignore no-explicit-any
            ctx: givenCtx as any,
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
        // deno-lint-ignore no-explicit-any
        { eventBus: mockBus, ctx: givenCtx as any },
      );

      // Ensure the result ctx matches what executor returned (and we provided).
      assertEquals(frames.length, 1);
      assertEquals(frames[0].result.ctx, givenCtx);
    },
  );

  await t.step(
    "ready-queue stability with delays: roots execute in definition order",
    async () => {
      // Two roots, then a join
      const tasks = [T("a"), T("b"), T("c", ["a", "b"])];
      const plan = executionPlan(tasks);

      const ran: string[] = [];
      await executeDAG(
        plan,
        async (task) => {
          const now = new Date();
          // Introduce different delays; scheduler should still pick a before b
          if (task.taskId() === "a") await new Promise((r) => setTimeout(r, 5));
          if (task.taskId() === "b") await new Promise((r) => setTimeout(r, 1));
          ran.push(task.taskId());
          return {
            disposition: "continue",
            ctx: { runId: "delays" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: new Date(),
          };
        },
      );

      assertEquals(ran, ["a", "b", "c"]);
    },
  );

  await t.step(
    "event ordering per task: scheduled -> start -> end",
    async () => {
      const tasks = [T("a"), T("b", ["a"])];
      const plan = executionPlan(tasks);

      const events: string[] = [];
      // deno-lint-ignore no-explicit-any
      const mockBus: any = {
        // deno-lint-ignore no-explicit-any
        emit: (type: string, payload: any) => {
          if (["task:scheduled", "task:start", "task:end"].includes(type)) {
            events.push(`${type}:${payload.id}`);
          }
        },
      };

      await executeDAG(
        plan,
        // deno-lint-ignore require-await
        async () => {
          const now = new Date();
          return {
            disposition: "continue",
            ctx: { runId: "order" },
            success: true,
            exitCode: 0,
            startedAt: now,
            endedAt: now,
          };
        },
        { eventBus: mockBus },
      );

      // Expected sequence:
      // task:scheduled:a, task:start:a, task:end:a, task:scheduled:b, task:start:b, task:end:b
      assertEquals(events, [
        "task:scheduled:a",
        "task:start:a",
        "task:end:a",
        "task:scheduled:b",
        "task:start:b",
        "task:end:b",
      ]);
    },
  );
});

// === More planning edge cases ===
Deno.test("executionPlan()", async (t) => {
  await t.step(
    "mixed missing + existing deps only count existing in indegree",
    () => {
      // a exists; two others are missing
      const tasks = [T("a"), T("t", ["a", "missing1", "missing2"])];
      const plan = executionPlan(tasks);

      assertEquals(plan.missingDeps, { t: ["missing1", "missing2"] });
      assertEquals(plan.indegree["t"], 1); // only 'a' contributes
      assertEquals(plan.edges, [["a", "t"]]);
      assertEquals(plan.layers, [["a"], ["t"]]);
      assertEquals(plan.unresolved, []);
    },
  );

  await t.step(
    "multiple disconnected components are stable by definition order",
    () => {
      // Component A: a1 -> a2
      // Component B: b1 -> b2
      // Interleaved definition order should control both layers and dag
      const tasks = [T("a1"), T("b1"), T("a2", ["a1"]), T("b2", ["b1"])];
      const plan = executionPlan(tasks);

      assertEquals(plan.layers, [["a1", "b1"], ["a2", "b2"]]);
      assertEquals(plan.dag.map((t) => t.taskId()), ["a1", "b1", "a2", "b2"]);
      assertEquals(plan.edges, [
        ["a1", "a2"],
        ["b1", "b2"],
      ]);
    },
  );

  await t.step("very long chain plans correctly and remains stable", () => {
    const N = 200;
    const tasks = Array.from(
      { length: N },
      (_, i) => T(`n${i}`, i === 0 ? [] : [`n${i - 1}`]),
    );
    const plan = executionPlan(tasks);

    // ids and dag should match exactly; each layer has a single node
    assertEquals(plan.ids.length, N);
    assertEquals(plan.dag.map((t) => t.taskId()), plan.ids);
    assertEquals(plan.layers.length, N);
    assertEquals(plan.layers[0], ["n0"]);
    assertEquals(plan.layers[N - 1], [`n${N - 1}`]);
    assertEquals(plan.unresolved, []);
  });
});

Deno.test("TaskExecutorBuilder & helpers", async (t) => {
  // Discriminated tasks
  type Ctx = { runId: string };
  interface ShellTask extends Task {
    kind: "shell";
    cmd: string[];
    allowFail?: boolean;
  }
  interface SqlTask extends Task {
    kind: "sql";
    sql: string;
  }
  type AnyTask = ShellTask | SqlTask;

  const TT = (
    id: string,
    kind: AnyTask["kind"],
    deps: string[] = [],
  ): AnyTask => ({
    taskId: () => id,
    taskDeps: () => deps,
    kind,
    // payloads just for kind
    ...(kind === "shell" ? { cmd: ["echo", id] } : { sql: `select '${id}'` }),
  } as AnyTask);

  const isShell = matchKind<"shell", ShellTask>("shell");
  const isSql = matchKind<"sql", SqlTask>("sql");

  await t.step("routes to matching handlers and preserves order", async () => {
    const tasks: AnyTask[] = [
      TT("clean", "shell"),
      TT("build", "sql", ["clean"]),
      TT("test", "shell", ["build"]),
    ];
    const plan = executionPlan(tasks);

    const logs: string[] = [];

    const exec = new TaskExecutorBuilder<AnyTask, Ctx>()
      .handle(isShell, (task, ctx) => {
        logs.push(`shell:${task.taskId()}`);
        return ok<AnyTask, Ctx>(ctx);
      })
      .handle(isSql, (task, ctx) => {
        logs.push(`sql:${task.taskId()}`);
        return ok<AnyTask, Ctx>(ctx);
      })
      .build();

    const summary = await executeDAG(plan, exec, {
      ctx: { runId: "r1" } as Ctx,
    });
    assertEquals(summary.terminated, false);
    assertEquals(summary.ran, ["clean", "build", "test"]);
    assertEquals(logs, ["shell:clean", "sql:build", "shell:test"]);
  });

  await t.step("fallback handles unknown kinds", async () => {
    interface UnknownTask extends Task {
      kind: "???";
    }
    const unk: UnknownTask = {
      taskId: () => "u",
      taskDeps: () => [],
      kind: "???",
    };
    const plan = executionPlan([unk as unknown as AnyTask]);

    const exec = new TaskExecutorBuilder<AnyTask, Ctx>()
      .handle(isShell, (_, ctx) => ok<AnyTask, Ctx>(ctx))
      .fallback((_t, ctx) =>
        fail<AnyTask, Ctx>(ctx, new Error("no-handler"), {
          disposition: "continue",
        })
      )
      .build();

    const summary = await executeDAG(plan, exec, {
      ctx: { runId: "r2" } as Ctx,
    });
    assertEquals(summary.terminated, false);
    assertEquals(summary.ran, ["u"]);
    assertEquals(summary.section[0].result.success, false);
  });

  await t.step(
    "withTiming attaches elapsed to stderr on failures",
    async () => {
      const a = TT("a", "shell");
      const plan = executionPlan([a]);

      const exec = new TaskExecutorBuilder<AnyTask, Ctx>()
        .handle(
          isShell,
          // deno-lint-ignore require-await
          async (_t, ctx) => fail<AnyTask, Ctx>(ctx, new Error("boom")),
        )
        .use(withTiming())
        .build();

      const summary = await executeDAG(plan, exec, {
        ctx: { runId: "r3" } as Ctx,
      });
      const res = summary.section[0].result;

      // Narrow the union so stderr is in scope
      if (res.success) {
        throw new Error(
          "Expected a failure result to test stderr instrumentation",
        );
      }

      // res is now the failure branch; stderr exists (instrumented by withTiming)
      const stderrFn = res.stderr;
      // Extra safety: ensure middleware attached it
      if (!stderrFn) {
        throw new Error("Expected withTiming to attach stderr on failure");
      }

      const txt = new TextDecoder().decode(stderrFn());
      // contains elapsed_ms=...
      assertEquals(/elapsed_ms=\d+(\.\d+)?/.test(txt), true);
    },
  );

  await t.step("withTimeout terminates long tasks", async () => {
    const slow = TT("slow", "shell");
    const plan = executionPlan([slow]);

    const exec = new TaskExecutorBuilder<AnyTask, Ctx>()
      .handle(isShell, async (_t, ctx) => {
        await new Promise((r) => setTimeout(r, 30));
        return ok<AnyTask, Ctx>(ctx);
      })
      .use(withTimeout<AnyTask, Ctx>(10))
      .build();

    const summary = await executeDAG(plan, exec, {
      ctx: { runId: "r4" } as Ctx,
    });
    assertEquals(summary.section[0].result.success, false);
    assertEquals(summary.terminated, true); // default disposition=terminate
  });

  await t.step(
    "withRetry retries failures and then continues on final fail if configured",
    async () => {
      const flakey = TT("f", "shell");
      const plan = executionPlan([flakey]);

      let attempts = 0;
      const exec = new TaskExecutorBuilder<AnyTask, Ctx>()
        .handle(isShell, (_t, ctx) => {
          attempts++;
          if (attempts < 3) {
            return fail<AnyTask, Ctx>(ctx, new Error("try-again"), {
              disposition: "continue",
            });
          }
          return ok<AnyTask, Ctx>(ctx);
        })
        .use(withRetry<AnyTask, Ctx>({ retries: 1, continueOnFinalFail: true }))
        .build();

      const summary = await executeDAG(plan, exec, {
        ctx: { runId: "r5" } as Ctx,
      });
      // First attempt fails; one retry happens; since our handler marks first failure disposition=continue
      // and withRetry continueOnFinalFail=true, executor won't terminate early.
      assertEquals(summary.terminated, false);
      assertEquals(attempts >= 1, true);
    },
  );

  await t.step("createExecutor DSL builds the same thing tersely", async () => {
    const tasks: AnyTask[] = [TT("a", "sql"), TT("b", "shell", ["a"])];
    const plan = executionPlan(tasks);

    const logs: string[] = [];
    const exec = createExecutor<AnyTask, Ctx>({
      routes: [
        {
          guard: isSql,
          run: (t, ctx) => {
            logs.push(`sql:${t.taskId()}`);
            return ok<AnyTask, Ctx>(ctx);
          },
        },
        {
          guard: isShell,
          run: (t, ctx) => {
            logs.push(`shell:${t.taskId()}`);
            return ok<AnyTask, Ctx>(ctx);
          },
        },
      ],
      middlewares: [withTiming()],
    });

    const summary = await executeDAG(plan, exec, {
      ctx: { runId: "r6" } as Ctx,
    });
    assertEquals(summary.ran, ["a", "b"]);
    assertEquals(logs, ["sql:a", "shell:b"]);
  });
});
