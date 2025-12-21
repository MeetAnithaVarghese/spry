import { assert, assertEquals, assertMatch } from "@std/assert";
import * as Defs from "./hook_test-fixture-defn.ts";

Deno.test("0) add: simplest pure-args hook", async () => {
  const implMod = await import("./hook_test-fixture-impl.ts");

  Defs.add.issues.clear();
  const res = await Defs.add.collect(implMod, { run: { args: [2, 3] } });

  assertEquals(res.implementations.length, 1);
  assert(res.executed);
  assertEquals(res.executed[0].status, "fulfilled");
  assertEquals(res.executed[0].value, 5);
  assertEquals(Defs.add.issues.list().length, 0);
});

Deno.test("1) minimalOnLoaded: one ctx arg, no optional surfaces", async () => {
  const implMod = await import("./hook_test-fixture-impl.ts");

  const res = await Defs.minimalOnLoaded.collect(implMod, {
    run: { args: [{ file: "a.md" }] },
  });

  assertEquals(res.implementations.length, 1);
  assert(res.executed);
  assertEquals(res.executed[0].status, "fulfilled");
});

Deno.test("2) onLoadedWithIssues: issues injected and used", async () => {
  const implMod = await import("./hook_test-fixture-impl.ts");

  Defs.onLoadedWithIssues.issues.clear();
  const res = await Defs.onLoadedWithIssues.collect(implMod, {
    run: {
      args: [{ file: "a.md" }],
      injectIssuesIntoFirstArg: true,
      validateSurfaces: true,
    },
  });

  assertEquals(res.implementations.length, 1);
  assert(res.executed);
  assertEquals(res.executed[0].status, "fulfilled");

  const issues = Defs.onLoadedWithIssues.issues.list();
  assert(issues.some((i) => i.code === "EXT_ONLOADED_ISSUES"));
});

Deno.test("3) onLoadedWithBus: type-safe host listen + impl emit", async () => {
  const implMod = await import("./hook_test-fixture-impl.ts");

  Defs.onLoadedWithBus.issues.clear();

  const seenNotes: string[] = [];
  const seenWarns: string[] = [];

  // ✅ Now typed: d is { message: string } and { code: string; message?: string }
  const offNote = Defs.onLoadedWithBus.bus?.on(
    "note",
    (d) => seenNotes.push(d.message),
  );
  const offWarn = Defs.onLoadedWithBus.bus?.on(
    "warn",
    (d) => seenWarns.push(d.code),
  );

  try {
    const res = await Defs.onLoadedWithBus.collect(implMod, {
      run: {
        args: [{ file: "a.md" }],
        injectIssuesIntoFirstArg: true,
        injectBusIntoFirstArg: true,
        validateSurfaces: true,
      },
    });

    assertEquals(res.implementations.length, 1);
    assert(res.executed);
    assertEquals(res.executed[0].status, "fulfilled");

    assertEquals(seenNotes, ["hello:a.md"]);

    // ✅ Typed payload
    Defs.onLoadedWithBus.bus?.emit("warn", {
      code: "HOST_WARN",
      message: "from host",
    });
    assertEquals(seenWarns, ["HOST_WARN"]);

    const issues = Defs.onLoadedWithBus.issues.list();
    assert(issues.some((i) => i.code === "EXT_ONLOADED_BUS"));
  } finally {
    offNote?.();
    offWarn?.();
  }
});

Deno.test("4) onLoadedFull: issues + bus + AbortSignal", async () => {
  const implMod = await import("./hook_test-fixture-impl.ts");

  Defs.onLoadedFull.issues.clear();

  const notes: string[] = [];
  // ✅ typed d
  const off = Defs.onLoadedFull.bus?.on("note", (d) => notes.push(d.message));

  try {
    const ac = new AbortController();

    const res = await Defs.onLoadedFull.collect(implMod, {
      run: {
        args: [{ file: "a.md", text: "hello", signal: ac.signal }],
        injectIssuesIntoFirstArg: true,
        injectBusIntoFirstArg: true,
        validateSurfaces: true,
      },
    });

    assertEquals(res.implementations.length, 1);
    assert(res.executed);
    assertEquals(res.executed[0].status, "fulfilled");

    assertEquals(notes, ["full:a.md"]);

    ac.abort();
  } finally {
    off?.();
  }
});

Deno.test("5) explode: defensive wrapper captures throw in issues", async () => {
  const implMod = await import("./hook_test-fixture-impl.ts");

  Defs.explode.issues.clear();
  const res = await Defs.explode.collect(implMod, { run: { args: ["x"] } });

  assertEquals(res.implementations.length, 1);
  assert(res.executed);
  assertEquals(res.executed[0].status, "rejected");

  const issues = Defs.explode.issues.list();
  assert(issues.length >= 1);

  const codes = issues.map((i) => i.code);
  assert(
    codes.includes("HOOK_IMPL_THROW") || codes.includes("HOOK_EXEC_FAILED"),
  );

  const blob = issues.map((i) =>
    JSON.stringify(i.cause ?? i.detail ?? i.message)
  ).join("\n");
  assertMatch(blob, /boom/);
});
