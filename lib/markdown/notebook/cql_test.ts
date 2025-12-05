// cql_test.ts
import { assertEquals, assertFalse } from "jsr:@std/assert@^1";
import { compileCqlMini } from "./cql.ts";
import { CodeCell } from "../governedmd.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function mkCell(
  partial: Partial<CodeCell<Any>> & { language?: string; source?: string },
): CodeCell<Any> {
  return {
    kind: "code",
    language: partial.language ?? "sql",
    source: partial.source ?? "",
    provenance: {
      path: (partial as Any)?.provenance?.path ?? "",
      filename: (partial as Any)?.provenance?.filename ?? "",
      index: (partial as Any)?.provenance?.index ?? 0,
      ...(partial as Any)?.provenance,
    },
    attrs: {
      ...(partial.attrs ?? {}),
    } as Record<string, unknown>,
    parsedPI: partial.parsedPI ?? {
      bareTokens: [],
      flags: {},
      firstToken: undefined,
      secondToken: undefined,
      hasEitherFlagOfType: () => false,
      hasFlagOfType: () => false,
    } as Any,
    pi: partial.pi,
    startLine: (partial as Any)?.startLine,
    endLine: (partial as Any)?.endLine,
    isVirtual: partial.isVirtual ?? false,
  };
}

const CELLS: CodeCell<Any>[] = [
  mkCell({
    language: "sql",
    source: `-- migration
CREATE   TABLE users (id integer primary key);`,
    provenance: {
      path: "/app/db/migrations/001-init.sql",
      filename: "001-init.sql",
      index: 0,
    },
    attrs: { env: "prod", tags: ["example", "migration"] },
    parsedPI: {
      bareTokens: [],
      flags: { capture: true },
      firstToken: "virtual",
      flags2: undefined,
    } as Any,
  }),
  mkCell({
    language: "sql",
    source: `-- migration
create table posts (id int, title text);`,
    provenance: {
      path: "/app/db/migrations/002-posts.sql",
      filename: "002-posts.sql",
      index: 1,
    },
    attrs: { env: "dev", tags: ["migration"] },
    parsedPI: {
      bareTokens: [],
      flags: {},
      firstToken: "virtual",
    } as Any,
  }),
  mkCell({
    language: "bash",
    source: `echo "hello"`,
    provenance: { path: "/scripts/hello.sh", filename: "hello.sh", index: 2 },
    attrs: { tags: ["example"] },
    parsedPI: {
      bareTokens: [],
      flags: { capture: true },
      firstToken: "run",
    } as Any,
  }),
  mkCell({
    language: "sql",
    source: `-- draft
CREATE TABLE temp (id int);`,
    provenance: {
      path: "/app/db/migrations/003-temp.draft.sql",
      filename: "003-temp.draft.sql",
      index: 3,
    },
    attrs: { env: "prod", tags: [] },
    parsedPI: {
      bareTokens: [],
      flags: {},
      firstToken: "virtual",
    } as Any,
  }),
  mkCell({
    language: "sql",
    source: `-- utility
-- no create here`,
    provenance: {
      path: "/app/db/util/cleanup.sql",
      filename: "cleanup.sql",
      index: 4,
    },
    attrs: {},
    parsedPI: undefined, // exercise missing parsedPI/flags
  }),
];

function names(xs: CodeCell<Any>[]): string[] {
  return xs.map((c) => (c.provenance as Any)?.filename ?? "");
}

Deno.test("CQL-mini compiler", async (t) => {
  await t.step("sql migrations with CREATE TABLE (glob + regex)", () => {
    const q =
      `lang:"sql" && path~glob("**/migrations/*.sql") && text~/CREATE\\s+TABLE/i`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    assertEquals(names(out), [
      "001-init.sql",
      "002-posts.sql",
      "003-temp.draft.sql",
    ]);
  });

  await t.step("tag('example') && flag('capture')", () => {
    const q = `tag("example") && flag("capture")`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    assertEquals(names(out), ["001-init.sql", "hello.sh"]);
  });

  await t.step(
    "has(pi.kind) && pi.kind:'virtual' && not draft filename",
    () => {
      const q = `has(pi.kind) && pi.kind:"virtual" && !(filename~".draft.")`;
      const run = compileCqlMini(q);
      const out = run(CELLS);
      assertEquals(names(out), ["001-init.sql", "002-posts.sql"]);
    },
  );

  await t.step("attr equality attr('env')=='prod'", () => {
    const q = `attr("env")=="prod"`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    assertEquals(names(out), ["001-init.sql", "003-temp.draft.sql"]);
  });

  await t.step("len(tags)>0 works and ignores non-arrays", () => {
    const q = `len(tags) > 0`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    assertEquals(names(out), ["001-init.sql", "002-posts.sql", "hello.sh"]);
  });

  await t.step("filename substring negative (!text~'DROP')", () => {
    const q = `!(text~"DROP TABLE")`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    // none of our samples have DROP TABLE, so all pass
    assertEquals(out.length, CELLS.length);
  });

  await t.step("path glob only (matches util file)", () => {
    const q = `path~glob("**/util/*.sql")`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    assertEquals(names(out), ["cleanup.sql"]);
  });

  await t.step("flags missing defaults to false", () => {
    const q = `flag("capture")`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    // capture true on 001-init.sql and hello.sh; missing flags on cleanup.sql should not match
    assertEquals(names(out), ["001-init.sql", "hello.sh"]);
    // sanity: ensure util/cleanup (no parsedPI) is not present
    assertFalse(names(out).includes("cleanup.sql"));
  });

  await t.step("string equality sugar ':' vs '=='", () => {
    const q1 = `lang:"bash"`; // String(c.language) === "bash"
    const q2 = `lang=="bash"`; // c.language === "bash"
    const run1 = compileCqlMini(q1);
    const run2 = compileCqlMini(q2);
    assertEquals(names(run1(CELLS)), ["hello.sh"]);
    assertEquals(names(run2(CELLS)), ["hello.sh"]);
  });

  await t.step("compose with || and && precedence", () => {
    const q = `lang:"bash" || (lang:"sql" && text~"utility")`;
    const run = compileCqlMini(q);
    const out = run(CELLS);
    assertEquals(names(out), ["hello.sh", "cleanup.sql"]);
  });
});

/** Minimal helper to make a CodeCell with flags */
function mkCellWithFlags(
  filename: string,
  capture: boolean | string | string[] | undefined,
  extraFlags: Record<string, unknown> = {},
): CodeCell<Any> {
  return {
    kind: "code",
    language: "bash",
    source: "",
    provenance: { path: `/tmp/${filename}`, filename, index: 0 },
    attrs: {},
    parsedPI: {
      bareTokens: [],
      flags: { capture, ...extraFlags },
      firstToken: "run",
    },
    isVirtual: false,
  } as unknown as CodeCell<Any>;
}

const FLAG_CELLS: CodeCell<Any>[] = [
  mkCellWithFlags("true.sh", true),
  mkCellWithFlags("false.sh", false),
  mkCellWithFlags("on.sh", "on"),
  mkCellWithFlags("empty-str.sh", ""),
  mkCellWithFlags("arr-ab.sh", ["alpha", "beta"]),
  mkCellWithFlags("arr-empty.sh", []),
  mkCellWithFlags("unset.sh", undefined),
  mkCellWithFlags("mode-fast.sh", undefined, { mode: "fast" }),
];

const N = (xs: CodeCell<Any>[]) =>
  xs.map((c) => (c.provenance as Any)?.filename ?? "");

Deno.test("CQL-mini flags", async (t) => {
  await t.step(`flag("capture") → enabled/present`, () => {
    const q = `flag("capture")`;
    const run = compileCqlMini(q);
    const out = run(FLAG_CELLS);
    // truthy: true, "on", ["alpha","beta"]
    // falsy: false, "", [], undefined
    assertEquals(N(out), ["true.sh", "on.sh", "arr-ab.sh"]);
  });

  await t.step(`bare flags.capture behaves like flag("capture")`, () => {
    const q = `flags.capture`;
    const run = compileCqlMini(q);
    const out = run(FLAG_CELLS);
    assertEquals(N(out), ["true.sh", "on.sh", "arr-ab.sh"]);
  });

  await t.step(`flags.capture == true / false`, () => {
    const qTrue = `flags.capture == true`;
    const qFalse = `flags.capture == false`;
    const runTrue = compileCqlMini(qTrue);
    const runFalse = compileCqlMini(qFalse);
    assertEquals(N(runTrue(FLAG_CELLS)), ["true.sh"]);
    assertEquals(N(runFalse(FLAG_CELLS)), ["false.sh"]);
  });

  await t.step(`flags.capture == "on" (string equality)`, () => {
    const q = `flags.capture == "on"`;
    const run = compileCqlMini(q);
    const out = run(FLAG_CELLS);
    assertEquals(N(out), ["on.sh"]);
  });

  await t.step(`has(flags.capture, "beta") (string[] membership)`, () => {
    const q = `has(flags.capture, "beta")`;
    const run = compileCqlMini(q);
    const out = run(FLAG_CELLS);
    assertEquals(N(out), ["arr-ab.sh"]);
  });

  await t.step(`has(flags.capture, "on") works for single-string flag`, () => {
    const q = `has(flags.capture, "on")`;
    const run = compileCqlMini(q);
    const out = run(FLAG_CELLS);
    assertEquals(N(out), ["on.sh"]);
  });

  await t.step(`negation: !flag("capture")`, () => {
    const q = `!flag("capture")`;
    const run = compileCqlMini(q);
    const out = run(FLAG_CELLS);
    assertEquals(
      N(out).sort(),
      [
        "arr-empty.sh",
        "empty-str.sh",
        "false.sh",
        "mode-fast.sh",
        "unset.sh",
      ].sort(),
    );
  });

  await t.step(`empty string and empty array are NOT enabled`, () => {
    const q = `flag("capture") || flags.capture`;
    const run = compileCqlMini(q);
    const names = N(run(FLAG_CELLS));
    assertFalse(names.includes("empty-str.sh"));
    assertFalse(names.includes("arr-empty.sh"));
  });

  await t.step(`unrelated flags still accessible: flags.mode == "fast"`, () => {
    const q = `flags.mode == "fast"`;
    const run = compileCqlMini(q);
    const out = run(FLAG_CELLS);
    assertEquals(N(out), ["mode-fast.sh"]);
  });
});
