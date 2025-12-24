// lib/extend/extension_test.ts
import { assert, assertEquals, assertMatch } from "@std/assert";
import * as z from "@zod/zod";
import * as Defs from "./extension_test-fixture-defn.ts";
import {
  call,
  callable,
  type CallableDefn,
  callableDefn,
  getCallableDefnMeta,
  isCallableDefn,
  loadCallablesFrom,
  scanCallables,
  scanDefns,
} from "./extension.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function isErrorLike(
  e: unknown,
): e is { name?: string; message?: string; issues?: unknown } {
  return !!e && typeof e === "object" &&
    ("name" in e || "message" in e || "issues" in e);
}

Deno.test("scanDefns auto-tags plain exported z.function() as callable definition", () => {
  const index = scanDefns(Defs);

  assert(index.get("plainZodFn"));
  assert(isCallableDefn(Defs.plainZodFn));
  const meta = getCallableDefnMeta(Defs.plainZodFn);
  assertEquals(meta.id, "plainZodFn");
  assertEquals(meta.name, "plainZodFn");
});

Deno.test("discovers callable implementations from module exports", async () => {
  const implMod = await import("./extension_test-fixture-impl.ts");
  const discovered = await loadCallablesFrom(implMod, {
    moduleSpecifier: "mem",
  });

  const ids = discovered.map((d) => d.meta.id).sort();
  assertEquals(ids, [
    "spry.math.add",
    "spry.playbook.minimalOnLoaded",
    "spry.test.explode",
  ]);
});

Deno.test("discovered implementation executes correctly", async () => {
  const implMod = await import("./extension_test-fixture-impl.ts");
  const discovered = await loadCallablesFrom(implMod);

  const addRec = discovered.find((d) => d.meta.id === "spry.math.add");
  assert(addRec);
  assertEquals(addRec.impl(2, 3), 5);
});

Deno.test("runtime validation still applies via Zod", () => {
  const add = callableDefn("t.add", {
    input: [z.number(), z.number()],
    output: z.number(),
  });
  const addImpl = callable(add, (a, b) => a + b);

  let threw = false;
  try {
    // @ts-expect-error runtime validation test
    addImpl("x", "y");
  } catch (e) {
    threw = true;
    assertMatch(String(e), /Invalid input/i);
  }
  assertEquals(threw, true);
});

Deno.test("scanDefns builds an id->defn index", () => {
  const index = scanDefns(Defs);

  assertEquals(Array.from(index.keys()).sort(), [
    "plainZodFn",
    "spry.math.add",
    "spry.playbook.minimalOnLoaded",
    "spry.test.explode",
  ]);

  const plain = index.get("plainZodFn");
  assert(plain);
  assert(isCallableDefn(plain));
  assertEquals(getCallableDefnMeta(plain).id, "plainZodFn");
});

Deno.test("host can implement a defn found by id from scanDefns()", () => {
  const index = scanDefns(Defs);

  const def = index.get("spry.math.add");
  assert(def);

  const addDef = def as unknown as CallableDefn<
    [z.ZodNumber, z.ZodNumber],
    z.ZodNumber
  >;

  const dyn = callable(addDef, (a, b) => a + b);

  assertEquals(dyn(7, 8), 15);

  let threw = false;
  try {
    // @ts-expect-error runtime validation test
    dyn("x", "y");
  } catch (e) {
    threw = true;
    const err = isErrorLike(e) ? e : { name: undefined, message: String(e) };
    assert(
      Array.isArray((err as { issues?: unknown }).issues) ||
        /Invalid input/i.test(String(err)),
    );
  }
  assertEquals(threw, true);
});

Deno.test("scanCallables discovers only implementations, not schemas", async () => {
  const implMod = await import("./extension_test-fixture-impl.ts");
  const discovered = scanCallables(implMod);

  const ids = discovered.map((d) => d.meta.id).sort();
  assertEquals(ids, [
    "spry.math.add",
    "spry.playbook.minimalOnLoaded",
    "spry.test.explode",
  ]);

  // defs module exports schemas; it should discover no implementations
  const none = scanCallables(Defs);
  assertEquals(none.length, 0);
});

Deno.test("callable() can run as long as the defn is tagged", () => {
  const def = callableDefn("x.add", {
    input: [z.number(), z.number()],
    output: z.number(),
  });

  const fn = callable(def, (a, b) => a + b);
  assertEquals(fn(1, 2), 3);

  let threw = false;
  try {
    // @ts-expect-error runtime validation test
    fn("x", "y");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("call executes discovered implementations by id", async () => {
  const implMod = await import("./extension_test-fixture-impl.ts");

  const results = await call(implMod, [
    { id: "spry.math.add", args: [2, 3] },
    { id: "spry.playbook.minimalOnLoaded", args: [{ file: "x" }] },
  ]);

  assertEquals(results.length, 2);

  const r0 = results[0]!;
  assertEquals(r0.id, "spry.math.add");
  assertEquals(r0.ok, true);
  if (r0.ok) assertEquals(r0.value, 5);

  const r1 = results[1]!;
  assertEquals(r1.id, "spry.playbook.minimalOnLoaded");
  assertEquals(r1.ok, true);
});

Deno.test("call supports defn-based requests too", async () => {
  // Ensure the defn is tagged (callableDefn does this).
  const inc = callableDefn("t.inc", {
    input: [z.number()],
    output: z.number(),
  });

  const incImpl = callable(inc, (n) => n + 1);
  const mod = { incImpl };

  const results = await call(mod, [{
    defn: inc as unknown as Any,
    args: [41],
  }]);

  assertEquals(results.length, 1);

  const r = results[0]!;
  assertEquals(r.id, "t.inc");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.value, 42);
});

Deno.test("call returns an error result when id is not found", async () => {
  const implMod = await import("./extension_test-fixture-impl.ts");

  const results = await call(implMod, [
    { id: "does.not.exist", args: [] },
  ]);

  assertEquals(results.length, 1);

  const r = results[0]!;
  assertEquals(r.id, "does.not.exist");
  assertEquals(r.ok, false);
  if (!r.ok) assertMatch(String(r.error), /No callable implementation/i);
});

Deno.test("call returns an error result when runtime validation fails", async () => {
  const implMod = await import("./extension_test-fixture-impl.ts");

  const results = await call(implMod, [
    { id: "spry.math.add", args: ["x", "y"] },
  ]);

  assertEquals(results.length, 1);

  const r = results[0]!;
  assertEquals(r.id, "spry.math.add");
  assertEquals(r.ok, false);
  if (!r.ok) {
    assert(
      /Invalid input/i.test(String(r.error)) ||
        (isErrorLike(r.error) &&
          Array.isArray((r.error as { issues?: unknown }).issues)),
    );
  }
});

Deno.test("call supports sync implementations via async API surface", async () => {
  const inc = callableDefn("t.inc2", {
    input: [z.number()],
    output: z.number(),
  });

  const incImpl = callable(inc, (n) => n + 1);
  const mod = { incImpl };

  const results = await call(mod, [{ id: "t.inc2", args: [41] }]);

  assertEquals(results.length, 1);

  const r = results[0]!;
  assertEquals(r.id, "t.inc2");
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.value, 42);
});
