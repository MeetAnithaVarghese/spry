// lib/spawn/sql-shell/sqlite_test.ts
//
// Unit tests for sqlite3 engine (:memory:).
// These are safe to run in parallel with other tests because they do not mutate
// global process env vars.

import { assert, assertEquals } from "@std/assert";
import {
  defineLanguageInitCatalog,
  type EngineTagged,
  type LanguageInitBase,
  type LanguageInitCatalog,
  LanguageSpawnShell,
} from "../code-shell.ts";
import { sqlite3Engine, sqliteInit } from "./mod.ts";
import { shell as createShell } from "../shell.ts";

const td = new TextDecoder();
function s(u8: Uint8Array): string {
  return td.decode(u8);
}

export async function hasSqlite3(): Promise<boolean> {
  try {
    const { success } = await new Deno.Command("sqlite3", {
      args: ["-version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false;
  }
}

export const sqliteAvailable = await hasSqlite3();

Deno.test({
  name: "sqlite3Engine (:memory:): SQL execution (subtests)",
  ignore: !sqliteAvailable,
  fn: async (t) => {
    async function spawnSql(
      sql: string,
      init?: Parameters<typeof sqliteInit>[0],
      opts?: {
        mode?: "stdin" | "file" | "eval" | "auto";
        runtimeArgs?: readonly string[];
        baggage?: unknown;
        catalog?: LanguageInitCatalog<LanguageInitBase & EngineTagged>;
        initRef?: { ref: string };
      },
    ) {
      const sh = new LanguageSpawnShell<unknown>(createShell<unknown>());
      const res = await sh.spawn({
        engine: sqlite3Engine,
        input: { kind: "text", text: sql, hint: { ext: ".sql" } },
        init: opts?.initRef ?? (init ? { init: sqliteInit(init) } : undefined),
        catalog: opts?.catalog,
        mode: opts?.mode,
        runtimeArgs: opts?.runtimeArgs,
        baggage: opts?.baggage,
      });
      return {
        ...res,
        stdoutText: s(res.stdout),
        stderrText: s(res.stderr),
      };
    }

    await t.step("basic SELECT via stdin", async () => {
      const res = await spawnSql("select 1;");
      assert(res.success);
      assertEquals(res.code, 0);
      assertEquals(res.stdoutText.trim(), "1");
      assertEquals(res.argv?.[0], "sqlite3");
      assertEquals(res.argv?.[1], ":memory:");
    });

    await t.step("practical DDL/DML + query (headers, csv mode)", async () => {
      const sql = [
        ".headers on",
        ".mode csv",
        "create table person(id integer primary key, name text not null, age int);",
        "insert into person(name, age) values ('Asha', 31), ('Bilal', 27), ('Zoya', 5);",
        "select count(*) as n, sum(age) as total_age from person;",
        "select name from person where age >= 27 order by age desc;",
      ].join("\n");

      const res = await spawnSql(sql, undefined, { runtimeArgs: ["-batch"] });
      assert(res.success);

      const lines = res.stdoutText.trim().split("\n").map((x) => x.trim());
      assertEquals(lines[0], "n,total_age");
      assertEquals(lines[1], "3,63");
      assertEquals(lines[2], "name");
      assertEquals(lines[3], "Asha");
      assertEquals(lines[4], "Bilal");
    });

    await t.step("transaction + join + computed column", async () => {
      const sql = [
        ".mode list",
        "begin;",
        "create table acct(id integer primary key, owner text not null);",
        "create table txn(id integer primary key, acct_id int not null, amt real not null,",
        "  foreign key(acct_id) references acct(id));",
        "insert into acct(owner) values ('Zubaida'), ('Rashid');",
        "insert into txn(acct_id, amt) values (1, 10.5), (1, -2.0), (2, 4.25);",
        "commit;",
        "select a.owner || ':' || printf('%.2f', sum(t.amt))",
        "  from acct a join txn t on t.acct_id = a.id",
        " group by a.id order by a.id;",
      ].join("\n");

      const res = await spawnSql(sql, undefined, { runtimeArgs: ["-batch"] });
      assert(res.success);

      const lines = res.stdoutText.trim().split("\n").map((x) => x.trim());
      assertEquals(lines[0], "Zubaida:8.50");
      assertEquals(lines[1], "Rashid:4.25");
    });

    await t.step(
      "constraint violation returns non-zero with .bail on",
      async () => {
        const sql = [
          ".bail on",
          "create table u(id integer primary key, email text unique);",
          "insert into u(email) values ('a@example.com');",
          "insert into u(email) values ('a@example.com');",
          "select 'should-not-print';",
        ].join("\n");

        const res = await spawnSql(sql, undefined, { runtimeArgs: ["-batch"] });
        assert(!res.success);
        assert(res.code !== 0);
        assertEquals(res.stdoutText.includes("should-not-print"), false);

        const err = res.stderrText.toLowerCase();
        assert(err.includes("unique") || err.includes("constraint"));
      },
    );

    await t.step("file mode executes .sql temp file", async () => {
      const sql = [
        ".mode list",
        "create table t(x int);",
        "insert into t(x) values (41), (1);",
        "select sum(x) from t;",
      ].join("\n");

      const res = await spawnSql(sql, undefined, {
        mode: "file",
        runtimeArgs: ["-batch"],
      });
      assert(res.success);
      assertEquals(res.stdoutText.trim(), "42");
      assert(res.argv);
      assertEquals(res.argv[0], "sqlite3");
      assertEquals(res.argv[1], ":memory:");
      assertEquals(res.argv[2].startsWith(".read "), true);
    });

    await t.step("catalog init by ref (explicit :memory:)", async () => {
      const catalog = defineLanguageInitCatalog({
        memdb: sqliteInit({ file: ":memory:" }),
      });

      const res = await spawnSql("select 'ok';", undefined, {
        initRef: { ref: "memdb" },
        catalog,
      });

      assert(res.success);
      assertEquals(res.stdoutText.trim(), "ok");
      assertEquals(res.argv?.[1], ":memory:");
    });

    await t.step("baggage is preserved through spawn", async () => {
      const baggage = { traceId: "t-123" };
      const res = await spawnSql("select 7;", undefined, { baggage });
      assert(res.success);
      assertEquals(res.stdoutText.trim(), "7");
      assertEquals(res.baggage, baggage);
    });
  },
});
