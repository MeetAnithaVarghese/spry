// lib/spawn/sql-shell/surveilr_test.ts
//
// Unit tests for surveilrShellEngine execution against an isolated temp state DB.
// These are safe to run in parallel with other tests because they do not mutate
// global process env vars and use per-call temp SQLite files.

import { assert, assertEquals } from "@std/assert";
import {
  defineLanguageInitCatalog,
  type EngineTagged,
  type LanguageInitBase,
  type LanguageInitCatalog,
  LanguageSpawnShell,
} from "../code-shell.ts";
import { shell as createShell } from "../shell.ts";
import { surveilrShellEngine, SurveilrShellInit } from "./surveilr.ts";

const td = new TextDecoder();
function s(u8: Uint8Array): string {
  return td.decode(u8);
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

function parseJsonArrayOfObjects(
  stdoutText: string,
): Array<Record<string, JsonValue>> {
  const v = JSON.parse(stdoutText) as unknown;
  assert(Array.isArray(v), "expected JSON array output");
  for (const row of v) {
    assert(
      row !== null && typeof row === "object" && !Array.isArray(row),
      "expected JSON array of objects",
    );
  }
  return v as Array<Record<string, JsonValue>>;
}

export async function hasSurveilr(): Promise<boolean> {
  try {
    const { success } = await new Deno.Command("surveilr", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false;
  }
}

export const surveilrAvailable = await hasSurveilr();

Deno.test({
  name: "surveilrShellEngine: SQL execution (subtests)",
  ignore: !surveilrAvailable,
  fn: async (t) => {
    async function spawnSql(
      sql: string,
      init?: Parameters<typeof SurveilrShellInit>[0],
      opts?: {
        mode?: "stdin" | "file" | "eval" | "auto";
        runtimeArgs?: readonly string[];
        baggage?: unknown;
        catalog?: LanguageInitCatalog<LanguageInitBase & EngineTagged>;
        initRef?: { ref: string };
      },
    ) {
      const stateDb = await Deno.makeTempFile({
        prefix: "surveilr-state-",
        suffix: ".sqlite.db",
      });

      try {
        const sh = new LanguageSpawnShell<unknown>(createShell<unknown>());

        const effectiveInit = SurveilrShellInit({
          output: "json",
          stateDbFsPath: stateDb,
          ...(init ?? {}),
        });

        const res = await sh.spawn({
          engine: surveilrShellEngine,
          input: { kind: "text", text: sql, hint: { ext: ".sql" } },
          init: opts?.initRef ?? { init: effectiveInit },
          catalog: opts?.catalog,
          mode: opts?.mode,
          runtimeArgs: opts?.runtimeArgs,
          baggage: opts?.baggage,
        });

        const stdoutText = s(res.stdout);
        const stderrText = s(res.stderr);

        return {
          ...res,
          stdoutText,
          stderrText,
          jsonRows: res.success
            ? parseJsonArrayOfObjects(stdoutText)
            : undefined,
          stateDb,
        };
      } finally {
        try {
          await Deno.remove(stateDb);
        } catch {
          /* ignore */
        }
      }
    }

    await t.step("basic SELECT via stdin", async () => {
      const res = await spawnSql("select 1 as n;");
      assert(res.success);
      assertEquals(res.code, 0);
      assert(res.jsonRows);
      assertEquals(res.jsonRows.length, 1);
      assertEquals(res.jsonRows[0]?.n, 1);
      assertEquals(res.argv?.[0], "surveilr");
      assertEquals(res.argv?.[1], "shell");
    });

    await t.step("multi-row SELECT via stdin", async () => {
      const sql = [
        "select 'Asha' as name",
        "union all select 'Bilal'",
        "order by name desc;",
      ].join("\n");

      const res = await spawnSql(sql);
      assert(res.success);
      assert(res.jsonRows);

      const names = res.jsonRows.map((r) => String(r.name));
      assertEquals(names, ["Bilal", "Asha"]);
    });

    await t.step("DDL/DML then DQL in separate calls", async () => {
      const stateDb = await Deno.makeTempFile({
        prefix: "surveilr-state-shared-",
        suffix: ".sqlite.db",
      });

      try {
        const sh = new LanguageSpawnShell<unknown>(createShell<unknown>());

        const init = SurveilrShellInit({
          output: "json",
          stateDbFsPath: stateDb,
        });

        // 1) DDL/DML only
        const ddlDml = [
          "create table synthetic_table1(id integer primary key, name text not null, age int);",
          "insert into synthetic_table1(name, age) values ('Asha', 31), ('Bilal', 27), ('Zoya', 5);",
        ].join("\n");

        const r1 = await sh.spawn({
          engine: surveilrShellEngine,
          input: { kind: "text", text: ddlDml, hint: { ext: ".sql" } },
          init: { init },
          mode: "file", // safe multi-statement for DDL/DML
        });

        assert(r1.success);

        // 2) DQL only
        const dql =
          "select name from synthetic_table1 where age >= 27 order by age desc;";
        const r2 = await sh.spawn({
          engine: surveilrShellEngine,
          input: { kind: "text", text: dql, hint: { ext: ".sql" } },
          init: { init },
        });

        assert(r2.success);
        const rows = parseJsonArrayOfObjects(s(r2.stdout));
        const names = rows.map((r) => String(r.name));
        assertEquals(names, ["Asha", "Bilal"]);
      } finally {
        try {
          await Deno.remove(stateDb);
        } catch {
          /* ignore */
        }
      }
    });

    // Replace the failing step with this version.
    // Key change: no explicit BEGIN/COMMIT since surveilr shell already wraps in a transaction.

    await t.step(
      "join + computed column (DDL/DML then DQL; no explicit transaction)",
      async () => {
        const stateDb = await Deno.makeTempFile({
          prefix: "surveilr-state-join-",
          suffix: ".sqlite.db",
        });

        try {
          const sh = new LanguageSpawnShell<unknown>(createShell<unknown>());

          const init = SurveilrShellInit({
            output: "json",
            stateDbFsPath: stateDb,
          });

          // 1) DDL/DML only (no BEGIN/COMMIT)
          const ddlDml = [
            "create table acct(id integer primary key, owner text not null);",
            "create table txn(",
            "  id integer primary key,",
            "  acct_id int not null,",
            "  amt real not null,",
            "  foreign key(acct_id) references acct(id)",
            ");",
            "insert into acct(owner) values ('Zubaida'), ('Rashid');",
            "insert into txn(acct_id, amt) values (1, 10.5), (1, -2.0), (2, 4.25);",
          ].join("\n");

          const r1 = await sh.spawn({
            engine: surveilrShellEngine,
            input: { kind: "text", text: ddlDml, hint: { ext: ".sql" } },
            init: { init },
            mode: "file",
          });

          assert(r1.success);

          // 2) DQL only
          const dql = [
            "select (a.owner || ':' || printf('%.2f', sum(t.amt))) as bal",
            "  from acct a join txn t on t.acct_id = a.id",
            " group by a.id order by a.id;",
          ].join("\n");

          const r2 = await sh.spawn({
            engine: surveilrShellEngine,
            input: { kind: "text", text: dql, hint: { ext: ".sql" } },
            init: { init },
          });

          assert(r2.success);

          const rows = parseJsonArrayOfObjects(s(r2.stdout));
          const bals = rows.map((r) => String(r.bal));
          assertEquals(bals, ["Zubaida:8.50", "Rashid:4.25"]);
        } finally {
          try {
            await Deno.remove(stateDb);
          } catch {
            /* ignore */
          }
        }
      },
    );

    await t.step("constraint violation returns non-zero", async () => {
      const sql = [
        "create table u(id integer primary key, email text unique);",
        "insert into u(email) values ('a@example.com');",
        "insert into u(email) values ('a@example.com');",
      ].join("\n");

      const res = await spawnSql(sql, { silent: true }, { mode: "file" });
      assert(!res.success);
      assert(res.code !== 0);

      const err = res.stderrText.toLowerCase();
      assert(err.includes("unique") || err.includes("constraint"));
    });

    await t.step("file mode executes temp .sql file (pure DQL)", async () => {
      // keep file-mode coverage but only DQL content (surveilr restriction)
      const sql = "select 42 as total;";

      const res = await spawnSql(sql, undefined, { mode: "file" });
      assert(res.success);
      assert(res.jsonRows);
      assertEquals(res.jsonRows.length, 1);
      assertEquals(res.jsonRows[0]?.total, 42);

      assert(res.argv);
      assertEquals(res.argv[0], "surveilr");
      assertEquals(res.argv[1], "shell");
      assert(res.argv[res.argv.length - 1].endsWith(".sql"));
    });

    await t.step("catalog init by ref (explicit state db)", async () => {
      const stateDb = await Deno.makeTempFile({
        prefix: "surveilr-catalog-",
        suffix: ".sqlite.db",
      });

      try {
        const catalog = defineLanguageInitCatalog({
          memdb: SurveilrShellInit({
            stateDbFsPath: stateDb,
            output: "json",
          }),
        });

        const sh = new LanguageSpawnShell<unknown>(createShell<unknown>());
        const res = await sh.spawn({
          engine: surveilrShellEngine,
          input: {
            kind: "text",
            text: "select 'ok' as v;",
            hint: { ext: ".sql" },
          },
          init: { ref: "memdb" },
          catalog,
        });

        assert(res.success);
        const rows = parseJsonArrayOfObjects(s(res.stdout));
        assertEquals(rows.length, 1);
        assertEquals(rows[0]?.v, "ok");
        assertEquals(res.argv?.[0], "surveilr");
        assertEquals(res.argv?.[1], "shell");
      } finally {
        try {
          await Deno.remove(stateDb);
        } catch {
          /* ignore */
        }
      }
    });

    await t.step("baggage is preserved through spawn", async () => {
      const baggage = { traceId: "t-123" };
      const res = await spawnSql("select 7 as n;", undefined, { baggage });
      assert(res.success);
      assert(res.jsonRows);
      assertEquals(res.jsonRows.length, 1);
      assertEquals(res.jsonRows[0]?.n, 7);
      assertEquals(res.baggage, baggage);
    });
  },
});
