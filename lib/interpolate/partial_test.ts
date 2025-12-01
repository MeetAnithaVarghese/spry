// lib/universal/partial_test.ts
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import z from "@zod/zod";

import {
  createInjectablePartial,
  createPlainPartial,
  partialContent,
  partialContentCollection,
  type PartialRenderResult,
} from "./partial.ts";

Deno.test("partialContent", async (t) => {
  await t.step("creates a plain partial without injection", () => {
    const p = createPlainPartial("plain", "hello world");

    assertEquals(p.identity, "plain");
    assertEquals(p.source, "hello world");
    assertEquals(p.injection, undefined);

    const result = p.content({ some: "value" });
    if (result instanceof Promise) {
      throw new Error("expected sync result");
    }

    assertEquals(result.status, "ok");
    assertEquals(result.content, "hello world");
    assertEquals(result.interpolate, true);
    assertEquals(result.locals, { some: "value" });
  });

  await t.step(
    "validates locals with schema in strict mode (invalid → invalid-args)",
    () => {
      const schema = z.object({ name: z.string() });
      const p = partialContent(
        "with-schema-strict",
        "content with schema",
        {
          schema,
          strictArgs: true,
        },
      );

      // @ts-expect-error intentionally passing invalid locals
      const result = p.content({ wrong: 123 });
      if (result instanceof Promise) {
        throw new Error("expected sync result");
      }

      assertEquals(result.status, "invalid-args");
      assertEquals(result.interpolate, false);
      assertStringIncludes(
        result.content,
        "Invalid arguments passed to partial 'with-schema-strict'",
      );
      assert(result.error);
    },
  );

  await t.step(
    "validates locals with schema in strict mode (valid → ok)",
    () => {
      const schema = z.object({ name: z.string() });
      const p = partialContent(
        "with-schema-strict-ok",
        "ok content",
        {
          schema,
          strictArgs: true,
        },
      );

      const result = p.content({ name: "Alice" });
      if (result instanceof Promise) {
        throw new Error("expected sync result");
      }

      assertEquals(result.status, "ok");
      assertEquals(result.content, "ok content");
      assertEquals(result.interpolate, true);
      assertEquals(result.locals, { name: "Alice" });
    },
  );

  await t.step(
    "schema in non-strict mode logs warning but still renders ok",
    () => {
      const schema = z.object({ name: z.string() });
      const p = partialContent(
        "with-schema-nonstrict",
        "lenient content",
        {
          schema,
          strictArgs: false,
        },
      );

      let warned = false;
      const originalWarn = console.warn;
      const warnings: unknown[][] = [];

      console.warn = (...args: unknown[]) => {
        warned = true;
        warnings.push(args);
        // NOTE: do *not* call originalWarn here – we want to capture, not print
      };

      // @ts-expect-error intentionally passing invalid locals
      const result = p.content({ wrong: 123 });

      console.warn = originalWarn;

      if (result instanceof Promise) {
        throw new Error("expected sync result");
      }

      assertEquals(result.status, "ok");
      assertEquals(result.content, "lenient content");
      assertEquals(result.interpolate, true);
      // @ts-expect-error runtime locals shape differs from schema; this is what non-strict mode allows
      assertEquals(result.locals, { wrong: 123 });
      assertEquals(warned, true);

      // Assert we captured a warning with our expected prefix
      const [firstWarn] = warnings;
      if (firstWarn && typeof firstWarn[0] === "string") {
        assertStringIncludes(
          firstWarn[0] as string,
          "partialContent('with-schema-nonstrict'): non-strict mode, ignoring invalid locals",
        );
      } else {
        throw new Error("expected at least one console.warn call");
      }
    },
  );

  await t.step("creates injectable fragments with various modes", () => {
    const prepend = createInjectablePartial(
      "prepend-wrapper",
      "-- header --",
      { globs: ["reports/**.sql"], prepend: true },
    );
    const append = createInjectablePartial(
      "append-wrapper",
      "-- footer --",
      { globs: ["logs/**.sql"], append: true },
    );
    const both = createInjectablePartial(
      "both-wrapper",
      "-- both --",
      { globs: ["**/*.md"], prepend: true, append: true },
    );
    const explicit = createInjectablePartial(
      "explicit-wrapper",
      "-- explicit --",
      { globs: ["**/*.txt"], mode: "append" },
    );

    assert(prepend.injection);
    assertEquals(prepend.injection?.mode, "prepend");

    assert(append.injection);
    assertEquals(append.injection?.mode, "append");

    assert(both.injection);
    assertEquals(both.injection?.mode, "both");

    assert(explicit.injection);
    assertEquals(explicit.injection?.mode, "append");
  });
});

Deno.test("partialContentCollection", async (t) => {
  await t.step("registers and retrieves partials", () => {
    const coll = partialContentCollection();

    const p1 = createPlainPartial("one", "content one");
    const p2 = createPlainPartial("two", "content two");

    coll.register(p1);
    coll.register(p2);

    assertEquals(coll.get("one")?.source, "content one");
    assertEquals(coll.get("two")?.source, "content two");
  });

  await t.step("duplicate policy controls registration behavior", () => {
    const coll = partialContentCollection();

    const first = createPlainPartial("dup", "first");
    const second = createPlainPartial("dup", "second");

    coll.register(first);

    // ignore
    coll.register(second, { onDuplicate: "ignore" });
    assertEquals(coll.get("dup")?.source, "first");

    // overwrite
    coll.register(second, { onDuplicate: "overwrite" });
    assertEquals(coll.get("dup")?.source, "second");

    // throw
    let threw = false;
    try {
      coll.register(first, { onDuplicate: "throw" });
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  });

  await t.step("debugIndex reflects injectable entries", () => {
    const coll = partialContentCollection();

    const broad = createInjectablePartial(
      "broad",
      "-- broad --",
      { globs: ["**/*.sql"], prepend: true },
    );
    const specific = createInjectablePartial(
      "specific",
      "-- specific --",
      { globs: ["reports/monthly/*.sql"], prepend: true },
    );
    const plain = createPlainPartial("plain", "no injection here");

    coll.register(broad);
    coll.register(specific);
    coll.register(plain);

    const idx = coll.debugIndex();

    // Should only include injectables
    const identities = idx.map((e) => e.identity);
    assertEquals(identities.sort(), ["broad", "specific"].sort());

    // Each entry has expected fields
    for (const entry of idx) {
      assert(typeof entry.pattern === "string");
      assert(typeof entry.wildcardScore === "number");
      assert(typeof entry.length === "number");
    }
  });

  await t.step("findInjectableForPath chooses most specific wrapper", () => {
    const coll = partialContentCollection();

    const broad = createInjectablePartial(
      "broad",
      "-- broad --",
      { globs: ["**/*.sql"], prepend: true },
    );
    const specific = createInjectablePartial(
      "specific",
      "-- specific --",
      { globs: ["reports/monthly/*.sql"], prepend: true },
    );

    coll.register(broad);
    coll.register(specific);

    const chosen1 = coll.findInjectableForPath("reports/monthly/jan.sql");
    const chosen2 = coll.findInjectableForPath("other/path/file.sql");

    assertEquals(chosen1?.identity, "specific");
    assertEquals(chosen2?.identity, "broad");
  });

  await t.step("compose applies injectable wrapper (prepend)", async () => {
    const coll = partialContentCollection();

    const wrapper = createInjectablePartial(
      "wrapper",
      "-- header --",
      { globs: ["reports/**.sql"], prepend: true },
    );
    const inner = createPlainPartial("inner", "SELECT * FROM table;");

    coll.register(wrapper);
    coll.register(inner);

    const innerRender = await inner.content({ x: 1 });

    const result = await coll.compose(innerRender, {
      path: "reports/monthly.sql",
    });

    assertEquals(result.status, "ok");
    assertEquals(
      result.content,
      "-- header --\nSELECT * FROM table;",
    );
    assertEquals(result.locals, { x: 1 });
    assertEquals(result.interpolate, true);
  });

  await t.step(
    "compose applies injectable wrapper (append / both)",
    async () => {
      const coll = partialContentCollection();

      const appendWrapper = createInjectablePartial(
        "append-wrapper",
        "-- footer --",
        { globs: ["logs/**.sql"], append: true },
      );
      const bothWrapper = createInjectablePartial(
        "both-wrapper",
        "-- both --",
        { globs: ["notes/**.sql"], prepend: true, append: true },
      );
      const inner = createPlainPartial("inner", "BODY");

      coll.register(appendWrapper);
      coll.register(bothWrapper);
      coll.register(inner);

      const innerRender = await inner.content({});

      const appendResult = await coll.compose(innerRender, {
        path: "logs/app.sql",
      });
      assertEquals(appendResult.status, "ok");
      assertEquals(
        appendResult.content,
        "BODY\n-- footer --",
      );

      const bothResult = await coll.compose(innerRender, {
        path: "notes/foo.sql",
      });
      assertEquals(
        bothResult.content,
        "-- both --\nBODY\n-- both --",
      );
    },
  );

  await t.step(
    "compose leaves content unchanged when no injectable matches",
    async () => {
      const coll = partialContentCollection();
      const inner = createPlainPartial("inner", "plain content");

      coll.register(inner);

      const innerRender = await inner.content({ y: 2 });
      const result = await coll.compose(innerRender, {
        path: "no/match/here.txt",
      });

      assertEquals(result, innerRender);
      assertEquals(result.content, "plain content");
      assertEquals(result.locals, { y: 2 });
      assertEquals(result.interpolate, true);
    },
  );

  await t.step(
    "compose returns render-error when wrapper validation fails in strict mode",
    async () => {
      const coll = partialContentCollection<{ name: string }>();

      const schema = z.object({ name: z.string() });

      const wrapper = partialContent<{ name: string }>(
        "strict-wrapper",
        "-- strict --",
        {
          schema,
          strictArgs: true,
          inject: { globs: ["strict/**"], prepend: true },
        },
      );
      const inner = createPlainPartial<{ name: string }>(
        "inner",
        "inner body",
      );

      coll.register(wrapper);
      coll.register(inner);

      // Intentionally call inner with invalid locals shape;
      // runtime will pass this through to wrapper and trigger validation failure.
      // @ts-expect-error intentionally missing `name` for runtime test
      const innerRender = await inner.content({});

      const result = await coll.compose(innerRender, {
        path: "strict/file.txt",
      });

      assertEquals(result.status, "render-error");
      assertEquals(result.interpolate, false);
      assertStringIncludes(
        result.content,
        "Injectable 'strict-wrapper' failed to render",
      );
    },
  );

  await t.step(
    "compose returns inner result unchanged when status is not ok",
    async () => {
      const coll = partialContentCollection<{ foo: string }>();

      // Register a wrapper just to prove we don't try to apply it.
      const wrapper = createInjectablePartial<{ foo: string }>(
        "wrapper",
        "-- header --",
        { globs: ["**/*.sql"], prepend: true },
      );
      coll.register(wrapper);

      const failingResult: PartialRenderResult<{ foo: string }> = {
        status: "render-error",
        content: "inner failed earlier",
        interpolate: false,
        locals: { foo: "bar" },
        error: new Error("boom"),
      };

      const composed = await coll.compose(failingResult, {
        path: "reports/test.sql",
      });

      // Compose should early-return without modification.
      assertEquals(composed, failingResult);
    },
  );

  await t.step(
    "renderWithInjection renders partial and applies wrapper",
    async () => {
      const coll = partialContentCollection<{ user: string }>();

      const wrapper = createInjectablePartial<{ user: string }>(
        "wrapper",
        "-- header for user --",
        { globs: ["reports/**.sql"], prepend: true },
      );
      const inner = createPlainPartial<{ user: string }>(
        "inner",
        "SELECT * FROM report;",
      );

      coll.register(wrapper);
      coll.register(inner);

      const result = await coll.renderWithInjection({
        identity: "inner",
        path: "reports/monthly.sql",
        locals: { user: "Alice" },
      });

      assertEquals(result.status, "ok");
      assertEquals(
        result.content,
        "-- header for user --\nSELECT * FROM report;",
      );
      assertEquals(result.locals, { user: "Alice" });
    },
  );

  await t.step(
    "renderWithInjection returns render-error when identity not found",
    async () => {
      const coll = partialContentCollection();

      const result = await coll.renderWithInjection({
        identity: "missing",
        path: "some/path.sql",
        locals: { anything: true } as Record<string, unknown>,
      });

      assertEquals(result.status, "render-error");
      assertEquals(result.interpolate, false);
      assertStringIncludes(result.content, "Partial 'missing' not found");
    },
  );
});
