import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { remark } from "remark";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

import codeFrontmatter from "./code-frontmatter.ts";
import codePartials, {
  codePartial,
  CODEPARTIAL_KEY,
  type CodePartialNode,
  codePartialsCollection,
  codePartialSNDF,
} from "./code-partial.ts";

import type { Root } from "types/mdast";

// deno-lint-ignore no-explicit-any
type Any = any;

// Helper: normalize sync-or-async renderer to a Promise result
async function render(
  p: ReturnType<typeof codePartial>,
  locals: Record<string, unknown> = {},
) {
  return await Promise.resolve(p.content(locals));
}

/**
 * Helper: wrap a CodePartial into a minimal synthetic CodePartialNode
 * so it can be registered into codePartialsCollection().
 */
function nodeFromPartial(p: ReturnType<typeof codePartial>): CodePartialNode {
  return {
    type: "code",
    lang: "ts",
    meta: null,
    value: p.source,
    data: {
      [CODEPARTIAL_KEY]: p,
    } as Any,
  } as CodePartialNode;
}

function pipeline() {
  return remark()
    .use(remarkGfm)
    .use(remarkFrontmatter, ["yaml"])
    .use(codeFrontmatter)
    .use(codePartials);
}

function codeNodes(tree: Root) {
  const out: Any[] = [];
  const walk = (n: Any) => {
    if (n.type === "code") out.push(n);
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

Deno.test("codePartials plugin with synthetic PARTIAL cells", async (t) => {
  await t.step("detects a plain PARTIAL without injection", () => {
    const md = [
      "```ts PARTIAL plain",
      "console.log('hello');",
      "```",
      "",
    ].join("\n");

    const processor = pipeline();
    const tree = processor.parse(md) as Root;
    processor.runSync(tree);

    const nodes = codeNodes(tree);
    assertEquals(nodes.length, 1);

    const node = nodes[0] as CodePartialNode;
    assert(codePartialSNDF.is(node));

    const cp = node.data[CODEPARTIAL_KEY];
    assertEquals(cp.identity, "plain");
    assertEquals(cp.injection, undefined);
    assertEquals(cp.source, "console.log('hello');");
  });

  await t.step("detects PARTIAL with injection flags and globs", () => {
    const md = [
      "```ts PARTIAL header --inject **/*.sql",
      "console.log('H');",
      "```",
      "",
    ].join("\n");

    const processor = pipeline();
    const tree = processor.parse(md) as Root;
    processor.runSync(tree);

    const node = codeNodes(tree)[0] as CodePartialNode;
    assert(codePartialSNDF.is(node));

    const cp = node.data[CODEPARTIAL_KEY];
    assertEquals(cp.identity, "header");
    assert(cp.injection);
    assertEquals(cp.injection?.globs, ["**/*.sql"]);
    assertEquals(cp.injection?.mode, "prepend"); // default when only --inject
  });

  await t.step("PARTIAL with append/prepend flags sets mode correctly", () => {
    const mdAppend = [
      "```ts PARTIAL footer --inject **/*.sql --append",
      "FOOTER",
      "```",
      "",
    ].join("\n");

    const mdBoth = [
      "```ts PARTIAL wrap --inject **/*.sql --prepend --append",
      "WRAP",
      "```",
      "",
    ].join("\n");

    const p = pipeline();

    const treeAppend = p.parse(mdAppend) as Root;
    p.runSync(treeAppend);
    const nodeAppend = codeNodes(treeAppend)[0] as CodePartialNode;
    const cpAppend = nodeAppend.data[CODEPARTIAL_KEY];
    assertEquals(cpAppend.injection?.mode, "append");

    const treeBoth = p.parse(mdBoth) as Root;
    p.runSync(treeBoth);
    const nodeBoth = codeNodes(treeBoth)[0] as CodePartialNode;
    const cpBoth = nodeBoth.data[CODEPARTIAL_KEY];
    assertEquals(cpBoth.injection?.mode, "both");
  });

  await t.step(
    "attrs used as Zod schema spec for locals validation",
    async () => {
      const md = [
        "```ts PARTIAL greet { name: { type: 'string' } }",
        "// body is irrelevant for validation",
        "```",
        "",
      ].join("\n");

      const processor = pipeline();
      const tree = processor.parse(md) as Root;
      processor.runSync(tree);

      const node = codeNodes(tree)[0] as CodePartialNode;
      const cp = node.data[CODEPARTIAL_KEY];

      // Valid locals
      const ok = await cp.content({ name: "Alice" });
      assertEquals(ok.interpolate, true);
      assertEquals(ok.content, "// body is irrelevant for validation");

      // Invalid locals
      const bad = await cp.content({ name: 123 });
      assertEquals(bad.interpolate, false);
      assertStringIncludes(bad.content, "Invalid arguments");
    },
  );

  await t.step("collect callback receives each PARTIAL node", () => {
    const md = [
      "```ts PARTIAL first",
      "A",
      "```",
      "",
      "```ts PARTIAL second",
      "B",
      "```",
      "",
    ].join("\n");

    const collected: CodePartialNode[] = [];

    const processor = remark()
      .use(remarkGfm)
      .use(remarkFrontmatter, ["yaml"])
      .use(codeFrontmatter)
      .use(codePartials, {
        collect(node) {
          collected.push(node);
        },
      });

    const tree = processor.parse(md) as Root;
    processor.runSync(tree);

    assertEquals(collected.length, 2);
    const ids = collected.map((n) => n.data[CODEPARTIAL_KEY].identity);
    assertEquals(ids.sort(), ["first", "second"]);
  });
});

Deno.test("codePartial() basic and injectable behaviors (direct)", async (t) => {
  await t.step("creates a plain partial without injection", async () => {
    const p = codePartial("plain", {}, "hello world");
    assertEquals(p.identity, "plain");
    assertEquals(p.injection, undefined);
    const r = await render(p, {});
    assertEquals(r.content, "hello world");
    assertEquals(r.interpolate, true);
  });

  await t.step(
    "creates an injectable with inject globs and default prepend",
    () => {
      const p = codePartial(
        "header",
        { inject: "**/*.sql" },
        "-- HEADER",
      );
      assertEquals(p.injection?.mode, "prepend");
      assertEquals(p.injection?.globs, ["**/*.sql"]);
    },
  );

  await t.step("creates an injectable with append mode", () => {
    const p = codePartial(
      "footer",
      { inject: "**/*.sql", append: true },
      "-- FOOTER",
    );
    assertEquals(p.injection?.mode, "append");
  });

  await t.step("creates an injectable with both prepend+append", () => {
    const p = codePartial(
      "wrap",
      { inject: "**/*.sql", prepend: true, append: true },
      "-- BEGIN\n-- END",
    );
    assertEquals(p.injection?.mode, "both");
  });

  await t.step("validates arguments when zodSchemaSpec provided", async () => {
    const p = codePartial(
      "withArgs",
      {},
      "Hi",
      {
        name: { type: "string" },
      },
    );
    const r = await render(p, { name: "Bob" });
    assertEquals(r.content, "Hi");
  });

  await t.step("returns error content for invalid locals", async () => {
    const p = codePartial(
      "withArgs",
      {},
      "Hi",
      {
        name: { type: "string" },
      },
    );
    const r = await render(p, { name: 123 });
    assertStringIncludes(r.content, "Invalid arguments");
    assertEquals(r.interpolate, false);
  });
});

Deno.test("codePartialsCollection() core behaviors", async (t) => {
  const col = codePartialsCollection();

  await t.step("registers and retrieves plain partials", async () => {
    const p = codePartial("plain", {}, "content");
    const node = nodeFromPartial(p);
    col.register(node);

    const gotNode = col.get("plain");
    assert(gotNode);

    const gotPartial = gotNode.data[CODEPARTIAL_KEY];
    const r = await render(gotPartial, {});
    assertEquals(r.content, "content");
  });

  await t.step("handles duplicates according to policy", async () => {
    const p1 = codePartial("dupe", {}, "a");
    const p2 = codePartial("dupe", {}, "b");
    const n1 = nodeFromPartial(p1);
    const n2 = nodeFromPartial(p2);

    // overwrite
    col.register(n1);
    col.register(n2, () => "overwrite");
    {
      const got = col.get("dupe")!;
      const r = await render(got.data[CODEPARTIAL_KEY], {});
      assertEquals(r.content, "b");
    }

    // ignore
    col.register(nodeFromPartial(codePartial("dupe", {}, "a")));
    col.register(nodeFromPartial(codePartial("dupe", {}, "b")), () => "ignore");
    {
      const got = col.get("dupe")!;
      const r = await render(got.data[CODEPARTIAL_KEY], {});
      assertEquals(r.content, "a");
    }

    // throw (sync) -> assertThrows
    const nThrow = nodeFromPartial(codePartial("dupe", {}, "x"));
    assertThrows(() => {
      col.register(nThrow, () => "throw");
    });
  });

  await t.step("indexes injectables for glob matching", () => {
    const inj1 = codePartial(
      "header",
      { inject: "**/*.sql" },
      "-- H",
    );
    const inj2 = codePartial(
      "footer",
      { inject: "reports/*.sql", append: true },
      "-- F",
    );
    col.register(nodeFromPartial(inj1));
    col.register(nodeFromPartial(inj2));

    const found1 = col.findInjectableForPath("x/foo.sql");
    const found2 = col.findInjectableForPath("reports/summary.sql");

    assert(found1?.identity === "header");
    assert(found2?.identity === "footer");
  });

  await t.step("compose() applies prepend mode correctly", async () => {
    const localCol = codePartialsCollection();
    const inj = codePartial(
      "wrapTxt",
      { inject: "**/*.txt" },
      "HEADER",
    );
    localCol.register(nodeFromPartial(inj));

    const result = await localCol.compose({
      content: "body",
      interpolate: true,
      locals: {},
    }, { path: "test.txt" });

    assertEquals(result.content, "HEADER\nbody");
  });

  await t.step("compose() applies both prepend+append correctly", async () => {
    const localCol = codePartialsCollection(); // fresh
    const inj = codePartial(
      "wrap2",
      { inject: "**/*.sql", prepend: true, append: true },
      "WRAP",
    );
    localCol.register(nodeFromPartial(inj));

    const result = await localCol.compose({
      content: "core",
      interpolate: true,
      locals: {},
    }, { path: "anything.sql" });

    assertEquals(result.content, "WRAP\ncore\nWRAP");
  });

  await t.step(
    "compose() returns error text if wrapper fails args validation",
    async () => {
      const localCol = codePartialsCollection(); // fresh

      const bad = codePartial(
        "bad",
        { inject: "**/*.oops" },
        "BAD",
        { name: { type: "string" } }, // schema expects string
      );
      localCol.register(nodeFromPartial(bad));

      const res = await localCol.compose({
        content: "BODY",
        interpolate: true,
        locals: { name: 123 }, // mismatch
      }, { path: "file.oops" });

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
    "compose() catches thrown wrapper errors gracefully",
    async () => {
      const localCol = codePartialsCollection();

      const throwingPartial = codePartial(
        "thrower",
        { inject: "**/*.boom" },
        "ignored",
      );

      // Replace content with a throwing function
      const newContent: typeof throwingPartial.content = () => {
        throw new Error("Kaboom");
      };
      (throwingPartial as { content: typeof newContent }).content = newContent;

      localCol.register(nodeFromPartial(throwingPartial));

      const res = await localCol.compose({
        content: "main",
        interpolate: true,
        locals: {},
      }, { path: "file.boom" });

      assertStringIncludes(res.content, "failed to render");
      assertEquals(res.interpolate, false);
    },
  );
});

Deno.test(
  "codePartialsCollection() selects most specific injectable by glob",
  async (t) => {
    const col = codePartialsCollection();

    await t.step(
      "prefers fewer wildcards and longer literals when composing",
      async () => {
        const generic = codePartial(
          "generic",
          { inject: "**/*.sql" },
          "GENERIC",
        );
        const specific = codePartial(
          "specific",
          { inject: "reports/*.sql" },
          "SPECIFIC",
        );
        col.register(nodeFromPartial(generic));
        col.register(nodeFromPartial(specific));

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
  },
);
