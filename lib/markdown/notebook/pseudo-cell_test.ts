// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1";
import { parseCellsFromSpec, pseudoCellsGenerator } from "./pseudo-cell.ts";

/**
 * Minimal stub types to satisfy generics in tests.
 * We only need `pb.notebook.provenance`.
 */
type Prov = { test: true };
const mkPB =
  () => ({ notebook: { provenance: { test: true } as Prov } } as any);

Deno.test("liveIncludes: expands import cell into materialized code cells", async (t) => {
  const { cellsFrom } = pseudoCellsGenerator<Prov>();

  // Create a temp workspace with a SQL file and a small binary (PNG-like) file.
  const tmp = await Deno.makeTempDir({ prefix: "live-includes-" });
  const migDir = join(tmp, "migrations");
  const assetDir = join(tmp, "assets");
  await Deno.mkdir(migDir, { recursive: true });
  await Deno.mkdir(assetDir, { recursive: true });

  const sqlPath = join(migDir, "init.sql");
  await Deno.writeTextFile(sqlPath, "CREATE TABLE t(x INT);");

  const pngPath = join(assetDir, "logo.png");
  await Deno.writeFile(pngPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47])); // PNG header bytes

  // Mock fetch for the remote URL test.
  const originalFetch = globalThis.fetch;
  // deno-lint-ignore require-await
  globalThis.fetch = async (_: RequestInfo | URL) =>
    new Response("REMOTE_JSON", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  await t.step(
    "parseCellsFromSpec: returns local and remote directives",
    async () => {
      const spec = [
        "# comment",
        "sql **/*.sql",
        "utf8 assets/**/*.png",
        "json https://example.com/conf/demo.json",
      ].join("\n");

      const direcs = await parseCellsFromSpec(spec, tmp);

      // Expect: one local SQL (init.sql), one local PNG, one remote JSON
      assertEquals(
        direcs.filter((d) => d.kind === "local" && d.language === "sql").length,
        1,
      );
      assertEquals(
        direcs.filter((d) => d.kind === "local" && d.language === "utf8")
          .length,
        1,
      );
      assertEquals(
        direcs.filter((d) => d.kind === "remote" && d.language === "json")
          .length,
        1,
      );

      // Spot-check directive laziness works (text path)
      const sqlD = direcs.find((d) =>
        d.kind === "local" && d.language === "sql"
      )!;
      assertEquals(await sqlD.asText(), "CREATE TABLE t(x INT);");

      // Spot-check remote text
      const jsonD = direcs.find((d) =>
        d.kind === "remote" && d.language === "json"
      )!;
      assertEquals(await jsonD.asText(), "REMOTE_JSON");
    },
  );

  await t.step(
    "cellsFrom: emits a text SQL cell with relative firstToken",
    async () => {
      const cell = {
        kind: "code",
        language: "import",
        source: "sql **/*.sql",
        parsedInfo: { flags: { base: tmp } },
      } as any;

      const pb = mkPB();

      const out: any[] = [];
      for await (const c of cellsFrom(cell, pb)) out.push(c);

      assertEquals(out.length, 1);
      const c = out[0];

      assertEquals(c.kind, "code");
      assertEquals(c.language, "sql");
      assertMatch(c.parsedInfo.firstToken, /migrations\/init\.sql$/);
      assertEquals(c.parsedInfo.flags["is-binary"], undefined);
      assertEquals(c.source.trim(), "CREATE TABLE t(x INT);");
      assertEquals(c.sourceElaboration.isRefToBinary, false);
      assertMatch(String(c.sourceElaboration.importedFrom), /init\.sql$/);
    },
  );

  await t.step(
    "cellsFrom: emits a binary (utf8) cell with JSON-serialized source",
    async () => {
      const cell = {
        kind: "code",
        language: "import",
        source: "utf8 assets/**/*.png",
        parsedInfo: { flags: { base: tmp } },
      } as any;

      const pb = mkPB();

      const out: any[] = [];
      for await (const c of cellsFrom(cell, pb)) out.push(c);

      assertEquals(out.length, 1);
      const c = out[0];

      assertEquals(c.language, "utf8");
      assertEquals(c.parsedInfo.flags["is-binary"], true);

      // For binary, source is JSON.stringify(directive)
      assert(typeof c.source === "string");
      assertMatch(c.source, /"kind":"local"/);
      assertEquals(c.sourceElaboration.isRefToBinary, true);
      assertEquals(c.sourceElaboration.encoding, "UTF-8");
      assertMatch(String(c.sourceElaboration.importedFrom), /logo\.png$/);
    },
  );

  await t.step(
    "cellsFrom: emits a remote JSON text cell with URL-derived firstToken",
    async () => {
      const remoteBase = "https://example.com/";
      const remoteUrl = "https://example.com/conf/demo.json";
      const cell = {
        kind: "code",
        language: "import",
        source: `json ${remoteUrl}`,
        parsedInfo: { flags: { base: remoteBase } },
      } as any;

      const pb = mkPB();
      const out: any[] = [];
      for await (const c of cellsFrom(cell, pb)) out.push(c);

      assertEquals(out.length, 1);
      const c = out[0];

      assertEquals(c.language, "json");
      assertEquals(c.parsedInfo.flags["is-binary"], undefined);
      // firstToken is the **relative path** from base for remote
      assertEquals(c.parsedInfo.firstToken, "conf/demo.json");
      assertEquals(c.source, "REMOTE_JSON");
      assertEquals(c.sourceElaboration.isRefToBinary, false);
      assertEquals(c.sourceElaboration.importedFrom, remoteUrl);
    },
  );

  // Cleanup fetch mock and tmp
  globalThis.fetch = originalFetch;
  await Deno.remove(tmp, { recursive: true });
});
