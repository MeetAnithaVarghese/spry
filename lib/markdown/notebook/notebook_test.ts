import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertGreater,
  assertMatch,
} from "jsr:@std/assert@^1";
import {
  safeSourceText,
  SourceRelativeTo,
} from "../../universal/content-acquisition.ts";
import {
  type Cell,
  type CodeCell,
  type MarkdownCell,
  type Notebook,
  notebooks,
  parsedTextFlags,
} from "./notebook.ts";

// Generic, attrs-preserving type guards
function isCode<T extends Record<string, unknown>>(
  c: Cell<string, T>,
): c is CodeCell<string, T> {
  return c.kind === "code";
}

function isMarkdown<T extends Record<string, unknown>>(
  c: Cell<string, T>,
): c is MarkdownCell<string> {
  return c.kind === "markdown";
}

async function loadFixture(
  src = "./notebook_test-fixture-01.md",
): Promise<string> {
  const safeText = await safeSourceText(
    new URL(src, import.meta.url),
    SourceRelativeTo.Module,
  );
  if (safeText.nature === "error") {
    console.error(safeText.error);
  }
  assert(safeText.nature != "error");
  return safeText.text;
}

Deno.test("Markdown Notebook core - complex fixture", async (t) => {
  // Load the complex fixture
  const md = await loadFixture();

  // Parse with the core — pass a single string (valid Source)
  const out: Notebook<string>[] = [];
  for await (
    const nb of notebooks({
      provenance: "prime",
      content: md,
      import: async (src) =>
        typeof src === "string"
          ? await loadFixture(src)
          : await loadFixture(src[0]),
    })
  ) {
    out.push(nb);
  }

  assertEquals(out.length, 1, "expected exactly one notebook");
  const nb = out[0];

  await t.step("frontmatter parsed", () => {
    const fm = nb.fm as Record<string, unknown>;
    assertEquals(fm.title, "Core Fixture 01 (Complex)");
    assertEquals(fm.tags, ["demo", "test", "complex"]);
    assertEquals((fm.presets as Record<string, unknown>)?.["sqlDefault"], {
      schema: "main",
      dryRun: false,
    });
  });

  await t.step("cell partitioning and kinds sequence", () => {
    const kinds = nb.cells.map((c) => c.kind);
    assertEquals(kinds, [
      "markdown",
      "markdown",
      "markdown",
      "code",
      "markdown",
      "code",
      "markdown",
      "code",
      "markdown",
      "code",
      "markdown",
      "code",
      "markdown",
      "code",
      "code",
      "code",
      "markdown",
    ]);
  });

  await t.step("sql code cell - language, info, attrs, and content", () => {
    const cell = nb.cells[3];
    assert(isCode(cell as Cell<string, Record<string, unknown>>));
    if (isCode(cell)) {
      assertEquals(cell.language, "sql");
      assertEquals(cell.info, "INFO MORE_INFO");
      assertEquals(cell.attrs, { id: 1, name: "patients", dryRun: true });
      assertMatch(cell.source, /SELECT\s+id/i);
      assert(
        typeof cell.startLine === "number" && typeof cell.endLine === "number",
      );
    }
  });

  await t.step("markdown after sql - narrative preserved", () => {
    const cell = nb.cells[4];
    assert(isMarkdown(cell));
    assertMatch(cell.text, /After the SQL code fence/);
    assert(
      typeof cell.startLine === "number" && typeof cell.endLine === "number",
    );
  });

  await t.step(
    "bash code cell - malformed JSON5 yields empty attrs and warning issue",
    () => {
      const cell = nb.cells[5];
      assert(isCode(cell));
      assertEquals(cell.language, "bash");
      assertEquals(cell.attrs, {}, "malformed meta should yield empty attrs");
      assertMatch(cell.source, /echo "Hello from a bash cell/);
      const warnings = nb.issues.filter((i) => i.kind === "fence-issue");
      assertGreater(warnings.length, 0, "expected at least one warning issue");
    },
  );

  await t.step("json code cell - language and payload", () => {
    const cell = nb.cells[7];
    assert(isCode(cell));
    assertEquals(cell.language, "json");
    assertMatch(cell.source, /"sku":\s*"ABC-123"/);
  });

  await t.step("xml code cell - language and structure", () => {
    const cell = nb.cells[9];
    assert(isCode(cell));
    assertEquals(cell.language, "xml");
    assertMatch(cell.source, /<inventory>/);
    assertMatch(cell.source, /<item id="2"/);
  });

  await t.step("csv code cell - language and header line", () => {
    const cell = nb.cells[11];
    assert(isCode(cell));
    assertEquals(cell.language, "csv");
    assertMatch(cell.source, /^id,name,qty/m);
  });

  await t.step("fish code cell - info meta and content", () => {
    const cell = nb.cells[13];
    assert(isCode(cell));
    assertEquals(cell.language, "fish");
    assertEquals(cell.info, "meta");
    assertMatch(cell.source, /echo "hello from fish"/);
  });

  await t.step("raw text code cell - treated as language 'text'", () => {
    const cell = nb.cells[14];
    assert(isCode(cell));
    assertEquals(cell.language, "text");
    assertMatch(cell.source, /raw code block without an explicit language/);
  });

  await t.step("imported cell - content is replaced with CSV fixture", () => {
    const cell = nb.cells[15];
    assert(isCode(cell));
    assertEquals(cell.language, "csv");
    assertMatch(cell.source, /id,name,qty/);
  });

  await t.step("final markdown cell - trailing paragraph after HR", () => {
    const cell = nb.cells[16];
    assert(isMarkdown(cell));
    assertMatch(cell.text, /trailing paragraph/);
  });
});

Deno.test("parsedTextFlags — array & string input with POSIX-style tokenization", async (t) => {
  await t.step("array input: collects bare tokens and simple flags", () => {
    const argv = ["build", "src/main.ts", "--out=dist", "--verbose"];
    const { bareTokens, flags } = parsedTextFlags(argv);

    assertEquals(bareTokens, ["build", "src/main.ts"]);
    assertEquals(flags.out, "dist");
    assertEquals(flags.verbose, true);
  });

  await t.step("array input: spaced values and equals values", () => {
    const argv = ["--out", "dist", "-t=release", "-k", "value"];
    const { bareTokens, flags } = parsedTextFlags(argv);

    assertEquals(bareTokens, []);
    assertEquals(flags.out, "dist");
    assertEquals(flags.t, "release");
    assertEquals(flags.k, "value");
  });

  await t.step("array input: repeated flags promote and append", () => {
    const argv = ["--tag", "a", "--tag=b", "--tag", "c"];
    const { bareTokens, flags } = parsedTextFlags(argv);

    assertEquals(bareTokens, []);
    assert(Array.isArray(flags.tag));
    assertArrayIncludes(flags.tag as string[], ["a", "b", "c"]);
  });

  await t.step("array input: boolean flags repeat -> array of 'true'", () => {
    const argv = ["--force", "--force"];
    const { flags } = parsedTextFlags(argv);

    assert(Array.isArray(flags.force));
    assertEquals(flags.force, ["true", "true"]);
  });

  await t.step("array input: short flags with/without values", () => {
    const argv = ["-v", "-o=dist", "-t", "debug"];
    const { bareTokens, flags } = parsedTextFlags(argv);

    assertEquals(bareTokens, []);
    assertEquals(flags.v, true);
    assertEquals(flags.o, "dist");
    assertEquals(flags.t, "debug");
  });

  await t.step("array input: bare tokens exclude consumed values", () => {
    const argv = ["run", "--file", "app.ts", "extra", "-m", "fast"];
    const { bareTokens, flags } = parsedTextFlags(argv);

    assertEquals(bareTokens, ["run", "extra"]);
    assertEquals(flags.file, "app.ts");
    assertEquals(flags.m, "fast");
  });

  await t.step("array input: base defaults and overwrite + append", () => {
    const base = { out: "build", v: false as boolean, tag: ["x"] as string[] };
    const argv = ["--out", "dist", "--v", "--tag", "a"];
    const { bareTokens, flags } = parsedTextFlags(argv, base);

    assertEquals(bareTokens, []);
    assertEquals(flags.out, "dist");
    assertEquals(flags.v, true);
    assert(Array.isArray(flags.tag));
    assertEquals(flags.tag, ["x", "a"]);
  });

  await t.step("array input: repeat after first -> array continuation", () => {
    const argv = ["--mode=dev", "--mode", "prod"];
    const { flags } = parsedTextFlags(argv);

    assert(Array.isArray(flags.mode));
    assertEquals(flags.mode, ["dev", "prod"]);
  });

  await t.step(
    "string input: POSIX tokenization with quotes and escapes",
    () => {
      const line = String
        .raw`build "src/main.ts" --out=dist --tag a --tag "b c" -v --path "C:\\Program Files\\X" --msg \"ok\" plain`;
      const { bareTokens, flags } = parsedTextFlags(line);

      // tokenization expectations
      assertEquals(bareTokens, ["build", "src/main.ts", "plain"]);
      assertEquals(flags.out, "dist");
      assert(Array.isArray(flags.tag));
      assertEquals(flags.tag, ["a", "b c"]);
      assertEquals(flags.v, true);
      assertEquals(flags.path, "C:\\Program Files\\X");
      assertEquals(flags.msg, '"ok"'); // outside quotes, backslash escapes -> literal "
    },
  );

  await t.step(
    "string input: values after flags are consumed, not bare",
    () => {
      const line = `run --file app.ts extra -m fast`;
      const { bareTokens, flags } = parsedTextFlags(line);

      assertEquals(bareTokens, ["run", "extra"]);
      assertEquals(flags.file, "app.ts");
      assertEquals(flags.m, "fast");
    },
  );

  await t.step(
    "string input: handles end-of-options markers & lone dashes as bare",
    () => {
      const line = `-- - --`;
      const { bareTokens, flags } = parsedTextFlags(line);

      assertEquals(bareTokens, []);
      assertEquals(Object.keys(flags).length, 0);
    },
  );
});
