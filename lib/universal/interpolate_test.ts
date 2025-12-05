import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { unsafeInterpolator } from "./interpolate.ts";

/**
 * Documentation-centric tests for `unsafeInterpolator`.
 *
 * SECURITY NOTE:
 *  - This utility compiles template strings into functions that execute arbitrary
 *    JavaScript expressions found inside `${ ... }`. Only use with trusted templates
 *    and trusted data.
 *
 * What these tests demonstrate:
 *  1) Basic usage with default `ctx` binding.
 *  2) Full template-literal power (arithmetic, function calls, optional chaining).
 *  3) Custom `ctxName` (e.g., expose context as `globals`).
 *  4) Caching on/off (functional behavior is identical).
 *  5) Identifier validation for local keys.
 *  6) Collision detection when a local key matches `ctxName`.
 */

Deno.test("unsafeInterpolator - documentation and behavior", async (t) => {
  type Ctx = {
    app: string;
    version: string;
    math: { pi: number };
    util: { up: (s: string) => string; sum: (...n: number[]) => number };
    features?: { flags?: Record<string, boolean> };
  };

  const ctx: Ctx = {
    app: "Spry",
    version: "2.4.0",
    math: { pi: Math.PI },
    util: {
      up: (s) => s.toUpperCase(),
      sum: (...n) => n.reduce((a, b) => a + b, 0),
    },
    features: { flags: { xray: true } },
  };

  await t.step(
    "1) Basic usage with default ctx (ctxName = 'ctx')",
    async () => {
      const { interpolate } = unsafeInterpolator<Ctx>(ctx); // defaults: { useCache: true, ctxName: "ctx" }

      const out = await interpolate(
        "Hello ${user}! App=${ctx.app}@${ctx.version} PI≈${ctx.math.pi.toFixed(2)} n=${n}",
        { user: "Zoya", n: 3 },
      );

      assertEquals(out, "Hello Zoya! App=Spry@2.4.0 PI≈3.14 n=3");
    },
  );

  await t.step(
    "2) Full power: expressions, calls, optional chaining",
    async () => {
      const { interpolate } = unsafeInterpolator<Ctx>(ctx);

      const out = await interpolate(
        [
          "UP=${ctx.util.up(user)}",
          "sum=${ctx.util.sum(a,b,c)}",
          "expr=${(a*b) + c}",
          "flag=${ctx.features?.flags?.xray ?? false}",
        ].join(" | "),
        { user: "zoya", a: 2, b: 3, c: 4 },
      );

      assertEquals(out, "UP=ZOYA | sum=9 | expr=10 | flag=true");
    },
  );

  await t.step(
    "3) Custom context name via ctxName (e.g., 'globals')",
    async () => {
      const { interpolate } = unsafeInterpolator<Ctx>(ctx, {
        ctxName: "globals",
      });

      const out = await interpolate(
        "App=${globals.app}@${globals.version} upper=${globals.util.up(user)}",
        { user: "Z" },
      );

      assertEquals(out, "App=Spry@2.4.0 upper=Z");
    },
  );

  await t.step(
    "4) Caching disabled behaves identically (no feature loss)",
    async () => {
      const { interpolate } = unsafeInterpolator<Ctx>(ctx, { useCache: false });

      const t1 = await interpolate(
        "A=${a} B=${b} A+B=${a+b} PI=${ctx.math.pi.toFixed(1)}",
        { a: 5, b: 7 },
      );
      const t2 = await interpolate(
        "A=${a} B=${b} A+B=${a+b} PI=${ctx.math.pi.toFixed(1)}",
        { a: 5, b: 7 },
      );

      assertEquals(t1, "A=5 B=7 A+B=12 PI=3.1");
      assertEquals(t2, "A=5 B=7 A+B=12 PI=3.1");

      // We don't assert on internal cache mechanics; we only assert the observable behavior.
    },
  );

  await t.step("5) Invalid local identifiers are rejected", async () => {
    const { interpolate } = unsafeInterpolator<Ctx>(ctx);

    // Local keys become `const` identifiers; invalid JS identifiers must throw.
    await assertRejects(
      async () =>
        await interpolate(
          "bad local key should trigger compile-time runtime error",
          { "user-name": "bad" } as unknown as Record<string, unknown>,
        ),
      Error,
      'Invalid local key "user-name". Use a simple JavaScript identifier.',
    );

    // Valid identifiers pass.
    const ok = await interpolate("OK ${user_name}", { user_name: "good" });
    assertEquals(ok, "OK good");
  });

  await t.step("6) Local key must not collide with ctxName", async () => {
    // Default ctxName is "ctx", so a local named "ctx" should be rejected.
    const { interpolate } = unsafeInterpolator<Ctx>(ctx);

    await assertRejects(
      () => interpolate("should throw", { ctx: 1 }),
      Error,
      'Local key "ctx" conflicts with ctxName',
    );

    // With custom ctxName, the collision follows the custom name.
    const { interpolate: interpolate2 } = unsafeInterpolator<Ctx>(ctx, {
      ctxName: "globals",
    });

    await assertRejects(
      () => interpolate2("should throw too", { globals: 1 }),
      Error,
      'Local key "globals" conflicts with ctxName',
    );
  });

  await t.step("7) Non-string values: template semantics apply", async () => {
    const { interpolate } = unsafeInterpolator<Ctx>(ctx);

    const out = await interpolate(
      "bool=${flag} num=${n} obj=${JSON.stringify(obj)}",
      { flag: false, n: 42, obj: { a: 1 } },
    );

    // We rely on normal JS template-literal semantics for stringification.
    assertMatch(out, /bool=false/);
    assertMatch(out, /num=42/);
    assertMatch(out, /obj=\{"a":1\}/);
  });

  await t.step("8) Multiple independent instances (isolation)", async () => {
    const i1 = unsafeInterpolator<Ctx>({ ...ctx, app: "A" });
    const i2 = unsafeInterpolator<Ctx>({ ...ctx, app: "B" });

    const r1 = await i1.interpolate("ctx=${ctx.app}", {});
    const r2 = await i2.interpolate("ctx=${ctx.app}", {});

    assertEquals(r1, "ctx=A");
    assertEquals(r2, "ctx=B");
  });
});
