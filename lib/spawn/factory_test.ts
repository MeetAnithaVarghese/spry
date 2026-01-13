import { assert, assertEquals, assertMatch } from "@std/assert";
import { catalogFromYaml, using } from "./factory.ts";

import {
  duckdbEngine,
  type DuckDbInit,
  type PgInit,
  psqlEngine,
  sqlite3Engine,
  type SqliteInit,
} from "./sql-shell/mod.ts";

import { bashEngine, cmdEngine, pwshEngine, shEngine } from "./os-shell.ts";

import { envEngine, envrcEngine } from "./function-shell.ts";

import { duckdbAvailable } from "./mod_test.ts";
import {
  surveilrShellEngine,
  type SurveilrShellInit,
} from "./sql-shell/surveilr.ts";

const td = new TextDecoder();

async function binAvailable(argv0: string): Promise<boolean> {
  try {
    const cmd = new Deno.Command(argv0, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    const r = await cmd.output();
    // Even if --version returns non-zero, the binary exists.
    return typeof r.code === "number";
  } catch {
    return false;
  }
}

// Add this helper near binAvailable(...)
async function hasSurveilr(): Promise<boolean> {
  // these are created in YAML during the tests
  try {
    await Deno.remove("/tmp/surveilr-factory-test.sqlite.db", {
      recursive: true,
    });
    await Deno.remove("/tmp/surveilr-factory-test2.sqlite.db", {
      recursive: true,
    });
  } catch {
    // ignore
  }
  return await binAvailable("surveilr");
}
const surveilrAvailable = await hasSurveilr();

function parseJsonArray(text: string): unknown[] {
  const v = JSON.parse(text);
  if (!Array.isArray(v)) {
    throw new Error("expected surveilr shell output to be a JSON array");
  }
  return v;
}

Deno.test({
  name: "code-shell-serde: YAML from string (subtests)",
  fn: async (t) => {
    await t.step(
      "parses `spawnables:` wrapper with postgres/sqlite/duckdb entries",
      () => {
        const yaml = `
spawnables:
  pg_local:
    engine: postgres
    host: 127.0.0.1
    port: "5432"
    user: app
    dbname: appdb
    env:
      PGSERVICE: local
      PGPASSFILE: /tmp/pgpass

  sqlite1:
    engine: sqlite
    file: ":memory:"
    env:
      SQLITE_TMP: 1

  duckdb1:
    engine: duckdb
    file: ":memory:"
`;

        const catalog = catalogFromYaml(yaml);

        assert(catalog.pg_local);
        assert(catalog.sqlite1);
        assert(catalog.duckdb1);

        const pg = catalog.pg_local as PgInit;
        const sqlite = catalog.sqlite1 as SqliteInit;
        const duck = catalog.duckdb1 as DuckDbInit;

        // Engine identity tagging should match the engine wrapper helpers.
        assertEquals(pg.engineId, psqlEngine.id);
        assertEquals(sqlite.engineId, sqlite3Engine.id);
        assertEquals(duck.engineId, duckdbEngine.id);

        // Validate essential fields survive.
        assertEquals(pg.host, "127.0.0.1");
        assertEquals(pg.port, "5432");
        assertEquals(pg.user, "app");
        assertEquals(pg.dbname, "appdb");

        assertEquals(sqlite.file, ":memory:");
        assertEquals(duck.file, ":memory:");

        // Env normalization: numbers should become strings.
        assert(pg.env);
        assertEquals(pg.env.PGSERVICE, "local");
        assertEquals(pg.env.PGPASSFILE, "/tmp/pgpass");

        assert(sqlite.env);
        assertEquals(sqlite.env.SQLITE_TMP, "1");
      },
    );

    await t.step(
      "parses when entries are top-level (no `spawnables:` wrapper)",
      () => {
        const yaml = `
pg_local:
  engine: postgres
  host: db.internal
  port: 5432
  user: readonly
  dbname: warehouse

sqlite1:
  engine: sqlite
  file: /tmp/example.db

duckdb1:
  engine: duckdb
  file: /tmp/example.duckdb
`;

        const catalog = catalogFromYaml(yaml);

        const pg = catalog.pg_local as PgInit;
        const sqlite = catalog.sqlite1 as SqliteInit;
        const duck = catalog.duckdb1 as DuckDbInit;

        assertEquals(pg.engineId, psqlEngine.id);
        assertEquals(sqlite.engineId, sqlite3Engine.id);
        assertEquals(duck.engineId, duckdbEngine.id);

        assertEquals(pg.host, "db.internal");
        assertEquals(pg.port, "5432"); // normalized from number
        assertEquals(pg.user, "readonly");
        assertEquals(pg.dbname, "warehouse");

        assertEquals(sqlite.file, "/tmp/example.db");
        assertEquals(duck.file, "/tmp/example.duckdb");
      },
    );

    await t.step("parses OS shells + function engines (env/envrc)", () => {
      const yaml = `
spawnables:
  bash1:
    engine: bash
    env:
      X: 1

  sh1:
    engine: sh

  pwsh1:
    engine: pwsh
    harden: true
    bypassExecutionPolicy: true

  cmd1:
    engine: cmd

  env1:
    engine: env

  envrc1:
    engine: envrc
`;

      const catalog = catalogFromYaml(yaml);

      assert(catalog.bash1);
      assert(catalog.sh1);
      assert(catalog.pwsh1);
      assert(catalog.cmd1);
      assert(catalog.env1);
      assert(catalog.envrc1);

      assertEquals(catalog.bash1.engineId, bashEngine.id);
      assertEquals(catalog.sh1.engineId, shEngine.id);
      assertEquals(catalog.pwsh1.engineId, pwshEngine.id);
      assertEquals(catalog.cmd1.engineId, cmdEngine.id);

      assertEquals(catalog.env1.engineId, envEngine.id);
      assertEquals(catalog.envrc1.engineId, envrcEngine.id);
    });

    await t.step("throws on unknown engine", () => {
      const yaml = `
spawnables:
  bad1:
    engine: mysql
    host: localhost
`;
      let threw = false;
      try {
        catalogFromYaml(yaml);
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
    });

    await t.step("throws when a catalog entry is not an object", () => {
      const yaml = `
spawnables:
  pg_local: "not-an-object"
`;
      let threw = false;
      try {
        catalogFromYaml(yaml);
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
    });

    await t.step("throws when env is not an object", () => {
      const yaml = `
spawnables:
  pg_local:
    engine: postgres
    host: 127.0.0.1
    env: "not-an-object"
`;
      let threw = false;
      try {
        catalogFromYaml(yaml);
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
    });

    await t.step(
      "exec sqlite3 :memory: from catalog (single spawn)",
      async () => {
        const yaml = `
spawnables:
  sqlite1:
    engine: sqlite
    file: ":memory:"
`;
        const catalog = catalogFromYaml(yaml);
        const db = using(catalog, "sqlite1");

        const sql = [
          "create table t(x integer);",
          "insert into t values (41), (1);",
          "select sum(x) as s from t;",
        ].join("\n");

        const res = await db.spawn({ kind: "text", text: sql });
        assert(res.success);

        const out = td.decode(res.stdout);
        assert(out.includes("42"));
      },
    );

    await t.step({
      name: "exec duckdb :memory: from catalog (single spawn)",
      ignore: !duckdbAvailable,
      fn: async () => {
        const yaml = `
spawnables:
  duckdb1:
    engine: duckdb
    file: ":memory:"
`;
        const catalog = catalogFromYaml(yaml);
        const db = using(catalog, "duckdb1");

        const sql = [
          "create table t(x integer);",
          "insert into t values (10), (32);",
          "select sum(x) as s from t;",
        ].join("\n");

        const res = await db.spawn({ kind: "text", text: sql });
        assert(res.success);

        const out = td.decode(res.stdout);
        assert(out.includes("42"));
      },
    });

    await t.step(
      "exec env function-engine mirrors input to stdout",
      async () => {
        const yaml = `
spawnables:
  env1:
    engine: env
`;
        const catalog = catalogFromYaml(yaml);
        const fn = using(catalog, "env1");

        const input = "A=1\nB=two\n";
        const res = await fn.spawn({ kind: "text", text: input });

        assert(res.success);
        assertEquals(res.code, 0);
        assertEquals(td.decode(res.stdout), input);
        assertEquals(res.stderr.length, 0);
      },
    );

    await t.step(
      "exec envrc function-engine mirrors input to stdout",
      async () => {
        const yaml = `
spawnables:
  envrc1:
    engine: envrc
`;
        const catalog = catalogFromYaml(yaml);
        const fn = using(catalog, "envrc1");

        const input = "export HELLO=world\n";
        const res = await fn.spawn({ kind: "text", text: input });

        assert(res.success);
        assertEquals(res.code, 0);
        assertEquals(td.decode(res.stdout), input);
        assertEquals(res.stderr.length, 0);
      },
    );

    await t.step({
      name: "exec bash from catalog (eval mode)",
      ignore: Deno.build.os === "windows",
      fn: async () => {
        const has = await binAvailable("bash");
        if (!has) return;

        const yaml = `
spawnables:
  bash1:
    engine: bash
`;
        const catalog = catalogFromYaml(yaml);
        const sh = using(catalog, "bash1");

        const res = await sh.spawn(
          { kind: "text", text: "echo 42" },
          { mode: "eval" },
        );

        assert(res.success);
        assertMatch(td.decode(res.stdout).trim(), /^42$/);
      },
    });

    await t.step({
      name: "exec sh from catalog (eval mode)",
      ignore: Deno.build.os === "windows",
      fn: async () => {
        const has = await binAvailable("sh");
        if (!has) return;

        const yaml = `
spawnables:
  sh1:
    engine: sh
`;
        const catalog = catalogFromYaml(yaml);
        const sh = using(catalog, "sh1");

        const res = await sh.spawn(
          { kind: "text", text: "echo 42" },
          { mode: "eval" },
        );

        assert(res.success);
        assertMatch(td.decode(res.stdout).trim(), /^42$/);
      },
    });

    await t.step({
      name: "exec pwsh from catalog (eval mode)",
      fn: async () => {
        const has = await binAvailable("pwsh") ||
          await binAvailable("powershell");
        if (!has) return;

        const yaml = `
spawnables:
  pwsh1:
    engine: pwsh
    harden: true
    bypassExecutionPolicy: true
`;
        const catalog = catalogFromYaml(yaml);
        const sh = using(catalog, "pwsh1");

        const res = await sh.spawn(
          { kind: "text", text: "Write-Output 42" },
          { mode: "eval" },
        );

        assert(res.success);
        assertMatch(td.decode(res.stdout).trim(), /^42$/);
      },
    });

    await t.step({
      name: "exec cmd from catalog (eval mode)",
      ignore: Deno.build.os !== "windows",
      fn: async () => {
        const has = await binAvailable("cmd");
        if (!has) return;

        const yaml = `
spawnables:
  cmd1:
    engine: cmd
`;
        const catalog = catalogFromYaml(yaml);
        const sh = using(catalog, "cmd1");

        const res = await sh.spawn(
          { kind: "text", text: "echo 42" },
          { mode: "eval" },
        );

        assert(res.success);
        assertMatch(td.decode(res.stdout).trim(), /^42$/);
      },
    });

    await t.step(
      "parses surveilr shell entry (engine tagging + sqliteDynExtn array)",
      () => {
        const yaml = `
spawnables:
  surveilr1:
    engine: surveilr
    stateDbFsPath: /tmp/surveilr-test.sqlite.db
`;
        const catalog = catalogFromYaml(yaml);

        assert(catalog.surveilr1);

        const s1 = catalog.surveilr1 as SurveilrShellInit;

        // Engine identity tagging should match the engine wrapper helper.
        assertEquals(s1.engineId, surveilrShellEngine.id);

        // Field survival
        assertEquals(s1.stateDbFsPath, "/tmp/surveilr-test.sqlite.db");
      },
    );

    await t.step("throws when surveilr sqliteDynExtn is not an array", () => {
      const yaml = `
spawnables:
  surveilr1:
    engine: surveilr
    stateDbFsPath: /tmp/surveilr-test.sqlite.db
    sqliteDynExtn: /tmp/ext1.so
`;
      let threw = false;
      try {
        catalogFromYaml(yaml);
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
    });

    await t.step({
      name: "exec surveilr shell from catalog (stdin, JSON output)",
      ignore: !surveilrAvailable,
      fn: async () => {
        const yaml = `
spawnables:
  surveilr1:
    engine: surveilr
    # use a temp db file for isolation (surveilr has its own internal tables)
    stateDbFsPath: /tmp/surveilr-factory-test.sqlite.db
`;
        const catalog = catalogFromYaml(yaml);
        const db = using(catalog, "surveilr1");

        const res = await db.spawn({
          kind: "text",
          text: "select 1 as n;",
        });

        assert(res.success);

        const out = td.decode(res.stdout);
        const rows = parseJsonArray(out);
        assertEquals(rows.length, 1);
        assertEquals((rows[0] as Record<string, unknown>).n, 1);
      },
    });

    await t.step({
      name:
        "exec surveilr: DDL/DML then DQL in separate calls (documented constraint)",
      ignore: !surveilrAvailable,
      fn: async () => {
        const yaml = `
spawnables:
  surveilr1:
    engine: surveilr
    stateDbFsPath: /tmp/surveilr-factory-test2.sqlite.db
`;
        const catalog = catalogFromYaml(yaml);
        const db = using(catalog, "surveilr1");

        // DDL/DML only
        const ddlDml = [
          "create table synthetic_table1(id integer primary key, name text not null, age int);",
          "insert into synthetic_table1(name, age) values ('Asha', 31), ('Bilal', 27), ('Zoya', 5);",
        ].join("\n");

        const r1 = await db.spawn({ kind: "text", text: ddlDml });
        assert(r1.success);

        // DQL only
        const dql =
          "select name from synthetic_table1 where age >= 27 order by age desc;";
        const r2 = await db.spawn({ kind: "text", text: dql });
        assert(r2.success);

        const rows = parseJsonArray(td.decode(r2.stdout));
        assertEquals(rows.map((r) => (r as Record<string, unknown>).name), [
          "Asha",
          "Bilal",
        ]);
      },
    });
  },
});

Deno.test({
  name: "code-shell-serde: YAML from object (subtests)",
  fn: async (t) => {
    await t.step("parses object with `spawnables:` wrapper", () => {
      const obj = {
        spawnables: {
          pg_local: {
            engine: "postgres",
            host: "127.0.0.1",
            port: 5432,
            user: "app",
            dbname: "appdb",
            env: { PGSERVICE: "local", PGPASSFILE: "/tmp/pgpass" },
          },
          sqlite1: {
            engine: "sqlite",
            file: ":memory:",
          },
          duckdb1: {
            engine: "duckdb",
            file: ":memory:",
            env: { SOME_FLAG: true },
          },
          env1: {
            engine: "env",
          },
          envrc1: {
            engine: "envrc",
          },
          bash1: {
            engine: "bash",
          },
          pwsh1: {
            engine: "pwsh",
            harden: true,
          },
        },
      };

      const catalog = catalogFromYaml(obj);

      const pg = catalog.pg_local as PgInit;
      const sqlite = catalog.sqlite1 as SqliteInit;
      const duck = catalog.duckdb1 as DuckDbInit;

      assertEquals(pg.engineId, psqlEngine.id);
      assertEquals(sqlite.engineId, sqlite3Engine.id);
      assertEquals(duck.engineId, duckdbEngine.id);

      assertEquals(pg.host, "127.0.0.1");
      assertEquals(pg.port, "5432"); // normalized
      assertEquals(pg.user, "app");
      assertEquals(pg.dbname, "appdb");

      assertEquals(sqlite.file, ":memory:");
      assertEquals(duck.file, ":memory:");

      assert(duck.env);
      assertEquals(duck.env.SOME_FLAG, "true");

      assertEquals(catalog.env1.engineId, envEngine.id);
      assertEquals(catalog.envrc1.engineId, envrcEngine.id);

      assertEquals(catalog.bash1.engineId, bashEngine.id);
      assertEquals(catalog.pwsh1.engineId, pwshEngine.id);
    });

    await t.step(
      "parses object with top-level entries (no `spawnables:` wrapper)",
      () => {
        const obj = {
          pg_local: {
            engine: "psql",
            host: "db.internal",
            port: "5432",
            user: "readonly",
            dbname: "warehouse",
          },
          sqlite1: {
            engine: "sqlite3",
            file: "/tmp/example.db",
          },
          duckdb1: {
            engine: "duckdb",
            file: "/tmp/example.duckdb",
          },
          env1: {
            engine: "env",
          },
          bash1: {
            engine: "bash",
          },
        };

        const catalog = catalogFromYaml(obj);

        const pg = catalog.pg_local as PgInit;
        const sqlite = catalog.sqlite1 as SqliteInit;
        const duck = catalog.duckdb1 as DuckDbInit;

        assertEquals(pg.engineId, psqlEngine.id);
        assertEquals(sqlite.engineId, sqlite3Engine.id);
        assertEquals(duck.engineId, duckdbEngine.id);

        assertEquals(pg.host, "db.internal");
        assertEquals(pg.port, "5432");
        assertEquals(pg.user, "readonly");
        assertEquals(pg.dbname, "warehouse");

        assertEquals(sqlite.file, "/tmp/example.db");
        assertEquals(duck.file, "/tmp/example.duckdb");

        assertEquals(catalog.env1.engineId, envEngine.id);
        assertEquals(catalog.bash1.engineId, bashEngine.id);
      },
    );

    await t.step("throws when object does not contain a catalog object", () => {
      const obj = [] as unknown as Record<string, unknown>;
      let threw = false;
      try {
        catalogFromYaml(obj);
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
    });

    await t.step("exec sqlite3 :memory: from object catalog", async () => {
      const obj = {
        spawnables: {
          sqlite1: { engine: "sqlite", file: ":memory:" },
        },
      };

      const catalog = catalogFromYaml(obj);
      const db = using(catalog, "sqlite1");

      const sql = [
        "create table t(x text);",
        "insert into t values ('ok');",
        "select x from t;",
      ].join("\n");

      const res = await db.spawn({ kind: "text", text: sql });
      assert(res.success);

      const out = td.decode(res.stdout);
      assert(out.includes("ok"));
    });

    await t.step("exec env function-engine from object catalog", async () => {
      const obj = {
        spawnables: {
          env1: { engine: "env" },
        },
      };

      const catalog = catalogFromYaml(obj);
      const fn = using(catalog, "env1");

      const input = "K=V\n";
      const res = await fn.spawn({ kind: "text", text: input });

      assert(res.success);
      assertEquals(td.decode(res.stdout), input);
    });

    await t.step({
      name: "exec duckdb :memory: from object catalog",
      ignore: !duckdbAvailable,
      fn: async () => {
        const obj = {
          spawnables: {
            duckdb1: { engine: "duckdb", file: ":memory:" },
          },
        };

        const catalog = catalogFromYaml(obj);
        const db = using(catalog, "duckdb1");

        const sql = [
          "create table t(x varchar);",
          "insert into t values ('ok');",
          "select x from t;",
        ].join("\n");

        const res = await db.spawn({ kind: "text", text: sql });
        assert(res.success);

        const out = td.decode(res.stdout);
        assert(out.includes("ok"));
      },
    });

    // In the second Deno.test (YAML from object), add this step:

    await t.step(
      "parses surveilr entry from object (engine tagging + sqliteDynExtn)",
      () => {
        const obj = {
          spawnables: {
            surveilr1: {
              engine: "surveilr",
              stateDbFsPath: "/tmp/surveilr-obj.sqlite.db",
              output: "json",
              sqliteDynExtn: ["/tmp/extA.so"],
              noObservability: true,
            },
          },
        };

        const catalog = catalogFromYaml(obj);

        const s1 = catalog.surveilr1 as SurveilrShellInit;
        assertEquals(s1.engineId, surveilrShellEngine.id);
        assertEquals(s1.stateDbFsPath, "/tmp/surveilr-obj.sqlite.db");
        assertEquals(s1.sqliteDynExtn, ["/tmp/extA.so"]);
        assertEquals(s1.output, "json");
      },
    );
  },
});
