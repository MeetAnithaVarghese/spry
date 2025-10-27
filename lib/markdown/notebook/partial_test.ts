import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@^1";
import { parsedTextFlags } from "./notebook.ts";
import { fbPartialCandidate, fbPartialsCollection } from "./partial.ts";

// Helper: normalize sync-or-async renderer to a Promise result
async function render(
  p: ReturnType<typeof fbPartialCandidate>,
  locals: Record<string, unknown> = {},
) {
  return await Promise.resolve(p.content(locals));
}

Deno.test("fbPartial() basic and injectable behaviors", async (t) => {
  await t.step("creates a plain partial without injection", async () => {
    const p = fbPartialCandidate(
      parsedTextFlags("PARTIAL plain"),
      "hello world",
    );
    assertEquals(p.identity, "plain");
    assertEquals(p.injection, undefined);
    const r = await render(p, {});
    assertEquals(r.content, "hello world");
    assertEquals(r.interpolate, true);
  });

  await t.step(
    "creates an injectable with --inject and default prepend",
    () => {
      const p = fbPartialCandidate(
        parsedTextFlags("PARTIAL header --inject **/*.sql"),
        "-- HEADER",
      );
      assertEquals(p.injection?.mode, "prepend");
      assertEquals(p.injection?.globs, ["**/*.sql"]);
    },
  );

  await t.step("creates an injectable with --append mode", () => {
    const p = fbPartialCandidate(
      parsedTextFlags("PARTIAL footer --inject **/*.sql --append"),
      "-- FOOTER",
    );
    assertEquals(p.injection?.mode, "append");
  });

  await t.step("creates an injectable with both prepend+append", () => {
    const p = fbPartialCandidate(
      parsedTextFlags("PARTIAL wrap --inject **/*.sql --prepend --append"),
      "-- BEGIN\n-- END",
    );
    assertEquals(p.injection?.mode, "both");
  });

  await t.step("validates arguments when zodSchemaSpec provided", async () => {
    const p = fbPartialCandidate(parsedTextFlags("PARTIAL withArgs"), "Hi", {
      name: { type: "string" },
    });
    const r = await render(p, { name: "Bob" });
    assertEquals(r.content, "Hi");
  });

  await t.step("returns error content for invalid locals", async () => {
    const p = fbPartialCandidate(parsedTextFlags("PARTIAL withArgs"), "Hi", {
      name: { type: "string" },
    });
    const r = await render(p, { name: 123 });
    assertStringIncludes(r.content, "Invalid arguments");
    assertEquals(r.interpolate, false);
  });
});

Deno.test("fbPartialsCollection() core behaviors", async (t) => {
  const col = fbPartialsCollection();

  await t.step("registers and retrieves plain partials", async () => {
    const p = fbPartialCandidate(parsedTextFlags("PARTIAL plain"), "content");
    col.register(p);
    const got = col.get("plain");
    assert(got);
    const r = await render(got, {});
    assertEquals(r.content, "content");
  });

  await t.step("handles duplicates according to policy", async () => {
    const p1 = fbPartialCandidate(parsedTextFlags("PARTIAL dupe"), "a");
    const p2 = fbPartialCandidate(parsedTextFlags("PARTIAL dupe"), "b");

    // overwrite
    col.register(p1);
    col.register(p2, () => "overwrite");
    {
      const r = await render(col.get("dupe")!, {});
      assertEquals(r.content, "b");
    }

    // ignore
    col.register(p1);
    col.register(p2, () => "ignore");
    {
      const r = await render(col.get("dupe")!, {});
      assertEquals(r.content, "a");
    }

    // throw (sync) -> assertThrows
    assertThrows(() => {
      col.register(p2, () => "throw");
    });
  });

  await t.step("indexes injectables for glob matching", () => {
    const inj1 = fbPartialCandidate(
      parsedTextFlags("PARTIAL header --inject **/*.sql"),
      "-- H",
    );
    const inj2 = fbPartialCandidate(
      parsedTextFlags("PARTIAL footer --inject reports/*.sql --append"),
      "-- F",
    );
    col.register(inj1);
    col.register(inj2);

    const found1 = col.findInjectableForPath("x/foo.sql");
    const found2 = col.findInjectableForPath("reports/summary.sql");

    assert(found1?.identity === "header");
    assert(found2?.identity === "footer");
  });

  await t.step("compose() applies prepend mode correctly", async () => {
    const inj = fbPartialCandidate(
      parsedTextFlags("PARTIAL wrap --inject **/*.txt"),
      "HEADER",
    );
    col.register(inj);

    const result = await col.compose({
      content: "body",
      interpolate: true,
      locals: {},
    }, { path: "test.txt" });

    assertEquals(result.content, "HEADER\nbody");
  });

  // --- Fix 1: isolate collection so 'wrap2' wins unambiguously ---
  await t.step("compose() applies both prepend+append correctly", async () => {
    const localCol = fbPartialsCollection(); // fresh, no earlier injectables

    const inj = fbPartialCandidate(
      parsedTextFlags("PARTIAL wrap2 --inject **/*.sql --prepend --append"),
      "WRAP",
    );
    localCol.register(inj);

    const result = await localCol.compose({
      content: "core",
      interpolate: true,
      locals: {},
    }, { path: "anything.sql" });

    // Now no tie with 'header' from previous steps
    assertEquals(result.content, "WRAP\ncore\nWRAP");
  });

  // --- Fix 2: trigger an actual schema failure by type mismatch ---
  await t.step(
    "compose() returns error text if wrapper fails args validation",
    async () => {
      const localCol = fbPartialsCollection(); // fresh to avoid surprises

      const bad = fbPartialCandidate(
        parsedTextFlags("PARTIAL bad --inject **/*.oops"),
        "BAD",
        { name: { type: "string" } }, // schema expects string
      );
      localCol.register(bad);

      const res = await localCol.compose({
        content: "BODY",
        interpolate: true,
        locals: { name: 123 }, // type mismatch -> forces validation failure
      }, { path: "file.oops" });

      // compose() intentionally hides inner zod details and returns a generic failure
      // so assert on the generic message instead of the zod text
      assertStringIncludes(res.content, "failed to render");
      assertEquals(res.interpolate, false);
    },
  );

  await t.step("compose() skips if no matching injectable", async () => {
    const result = await col.compose({
      content: "x",
      interpolate: true,
      locals: {},
    }, { path: "no/match.json" });

    assertEquals(result.content, "x");
  });

  await t.step(
    "compose() returns error text if wrapper fails args validation (compose generic message)",
    async () => {
      const localCol = fbPartialsCollection(); // isolate from prior registrations

      // Wrapper requires { name: string }
      const bad = fbPartialCandidate(
        parsedTextFlags("PARTIAL bad2 --inject **/*.oops"),
        "BAD",
        { name: { type: "string" } },
      );
      localCol.register(bad);

      // Deliberately fail schema via type mismatch
      const res = await localCol.compose(
        {
          content: "BODY",
          interpolate: true,
          locals: { name: 123 }, // <-- mismatch on purpose
        },
        { path: "file.oops" },
      );

      // compose() returns a generic message (by design) and interpolate=false
      const generic = res.content.includes("failed to render") ||
        res.content.includes("wrapper reported invalid arguments");
      assert(
        generic,
        `unexpected compose() message: ${res.content}`,
      );
      assertEquals(res.interpolate, false);
    },
  );

  await t.step(
    "compose() catches thrown wrapper errors gracefully",
    async () => {
      const throwingPartial = fbPartialCandidate(
        parsedTextFlags("PARTIAL thrower --inject **/*.boom"),
        "ignored",
      );

      // Override without `any`: reassign using a compatible, explicit type
      const newContent: typeof throwingPartial.content = () => {
        throw new Error("Kaboom");
      };
      (throwingPartial as { content: typeof newContent }).content = newContent;

      col.register(throwingPartial);

      const res = await col.compose({
        content: "main",
        interpolate: true,
        locals: {},
      }, { path: "file.boom" });

      assertStringIncludes(res.content, "failed to render");
      assertEquals(res.interpolate, false);
    },
  );
});

Deno.test("fbPartialsCollection() integration with multiple injectables", async (t) => {
  const col = fbPartialsCollection();

  await t.step(
    "selects most specific match (fewer wildcards, longer literal)",
    async () => {
      const generic = fbPartialCandidate(
        parsedTextFlags("PARTIAL generic --inject **/*.sql"),
        "GENERIC",
      );
      const specific = fbPartialCandidate(
        parsedTextFlags("PARTIAL specific --inject reports/*.sql"),
        "SPECIFIC",
      );
      col.register(generic);
      col.register(specific);

      const r = await col.compose({
        content: "BODY",
        interpolate: true,
        locals: {},
      }, { path: "reports/summary.sql" });

      // Should pick specific, not generic
      assertStringIncludes(r.content, "SPECIFIC");
      assert(!r.content.includes("GENERIC"));
    },
  );
});
