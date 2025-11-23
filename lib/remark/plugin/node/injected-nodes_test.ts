// injected-nodes_test.ts

import { assert, assertEquals, assertFalse, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { remark } from "remark";
import type { Code, Root } from "types/mdast";

import {
  instructionsFromText,
  queryPosixPI,
} from "../../../universal/posix-pi.ts";
import { injectedNDF, injectedNodes } from "./injected-nodes.ts";

function getCodeNodes(tree: Root): Code[] {
  return (tree.children.filter((n) => n.type === "code") as Code[]);
}

Deno.test("injectedNodes: expands import spec into local SQL and binary utf8 nodes", async (t) => {
  // Create temp workspace with a SQL file and a small binary (PNG-like) file.
  const tmp = await Deno.makeTempDir({ prefix: "injected-nodes-" });
  const migDir = join(tmp, "migrations");
  const assetDir = join(tmp, "assets");
  await Deno.mkdir(migDir, { recursive: true });
  await Deno.mkdir(assetDir, { recursive: true });

  const sqlPath = join(migDir, "init.sql");
  await Deno.writeTextFile(sqlPath, "CREATE TABLE t(x INT);");

  const pngPath = join(assetDir, "logo.png");
  await Deno.writeFile(pngPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47])); // PNG header bytes

  const textSpec = [
    "# comment",
    "sql **/*.sql --spc",
    "utf8 assets/**/*.png",
  ];
  const md = [
    "```import --base " + tmp,
    ...textSpec,
    "```",
    "",
  ].join("\n");

  const processor = remark().use(injectedNodes);
  const tree = processor.runSync(processor.parse(md)) as Root;

  const codes = getCodeNodes(tree);
  // 1 spec block + 2 injected blocks
  assertEquals(codes.length, 3);

  const [spec] = codes;

  await t.step("spec block remains unchanged", () => {
    assertEquals(spec.lang, "import");
    assertEquals(spec.value ?? "", textSpec.join("\n"));
  });

  await t.step(
    "injected SQL node: text cell with relative firstToken and contents",
    () => {
      const [_spec, injectedSql] = codes;
      assertEquals(injectedSql.lang, "sql");
      assert(injectedSql.meta);
      const ift = instructionsFromText(
        `${injectedSql.lang} ${injectedSql.meta}`.trim(),
      );
      const qpi = queryPosixPI(ift.pi);

      // meta should start with a relative path into migrations, ending in init.sql
      assertEquals(qpi.bareWords[0], "migrations/init.sql");
      assertFalse(qpi.hasFlag("import"));
      assertEquals(injectedSql.value.trim(), "CREATE TABLE t(x INT);");

      // injectedNode metadata
      assert(injectedNDF.is(injectedSql));
      const src = injectedSql.data.injectedContent;
      assertFalse(src.isRefToBinary);
      assertMatch(String(src.importedFrom), /init\.sql$/);
      assertEquals(src.original.trim(), "CREATE TABLE t(x INT);");
    },
  );

  await t.step("injected PNG node: binary utf8 ref with is-binary flag", () => {
    const [_spec, _injectedSql, injectedPng] = codes;
    assertEquals(injectedPng.lang, "utf8");
    assert(injectedPng.meta);

    const ift = instructionsFromText(
      `${injectedPng.lang} ${injectedPng.meta}`.trim(),
    );
    const qpi = queryPosixPI(ift.pi);

    // meta should start with a relative path into migrations, ending in init.sql
    assertEquals(qpi.bareWords[0], "assets/logo.png");
    assert(qpi.hasFlag("import"));
    assert(qpi.hasFlag("is-binary"));
    // For binary, we don't stuff bytes into value
    assertEquals(injectedPng.value, "");

    assert(injectedNDF.is(injectedPng));
    const src = injectedPng.data.injectedContent;
    assert(src.isRefToBinary);
    assertEquals(src.encoding, "UTF-8");
    assertMatch(String(src.importedFrom), /logo\.png$/);
    // rs should be a ReadableStream if present
    assert(src.stream);
  });

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("injectedNodes: expands remote JSON spec into injected remote node", () => {
  const remoteBase = "https://example.com/";
  const remoteUrl = "https://example.com/conf/demo.json";

  const md = [
    "```import --inject --base " + remoteBase,
    `json ${remoteUrl}`,
    "```",
    "",
  ].join("\n");

  const processor = remark().use(injectedNodes);
  const tree = processor.runSync(processor.parse(md)) as Root;

  const codes = getCodeNodes(tree);
  // 1 spec block + 1 injected block
  assertEquals(codes.length, 2);

  const [_spec, injectedJson] = codes;

  assertEquals(injectedJson.lang, "json");
  assert(injectedJson.meta);

  const ift = instructionsFromText(
    `${injectedJson.lang} ${injectedJson.meta}`.trim(),
  );
  const qpi = queryPosixPI(ift.pi);

  // meta should start with a relative path into migrations, ending in init.sql
  assertEquals(qpi.bareWords[0], "conf/demo.json");
  assertEquals(qpi.getTextFlag("import"), "https://example.com/conf/demo.json");

  // No eager value for remote; it's a ref
  assertEquals(injectedJson.value, "");

  assert(injectedNDF.is(injectedJson));
  const src = injectedJson.data.injectedContent;
  assert(src.isRefToBinary);
  assertEquals(src.encoding, "UTF-8");
  assertEquals(src.importedFrom, remoteUrl);
  assert(src.stream);
});
