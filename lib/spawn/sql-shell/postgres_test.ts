// lib/spawn/sql-shell/postgres_test.ts
//
// Unit tests for Postgres helper utilities and plan wiring.
//
// Important: these tests mutate global process env vars (Deno.env.*).
// Deno parallelizes *test cases* across files, so the safest way to reduce
// flakiness without introducing a mutex is to group all env-sensitive checks
// under ONE parent Deno.test and use t.step.
//
// This ensures steps are not parallelized with each other. It does NOT prevent
// other files from running in parallel, so keep all env mutations in this file
// (and avoid Deno.env mutation elsewhere).

import { assert, assertEquals } from "@std/assert";
import { defineLanguageInitCatalog } from "../code-shell.ts";
import {
  duckdbEngine,
  duckdbInit,
  hydratePgInitWithSecrets,
  pgEnv,
  pgInit,
  pgPasswordFromPgpass,
  pgSecretFromJsonEnv,
  pgServiceFromConf,
  psqlEngine,
  sqlite3Engine,
  sqliteInit,
} from "./mod.ts";

type EnvSnapshot = Map<string, string | undefined>;

function snapshotEnv(keys: readonly string[]): EnvSnapshot {
  const saved: EnvSnapshot = new Map();
  for (const k of keys) saved.set(k, Deno.env.get(k));
  return saved;
}

function restoreEnv(saved: EnvSnapshot): void {
  for (const [k, v] of saved.entries()) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}

async function withTempEnv<T>(
  keysToTouch: readonly string[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved = snapshotEnv(keysToTouch);
  try {
    // Clear touched vars first to reduce cross-test contamination.
    for (const k of keysToTouch) Deno.env.delete(k);
    return await fn();
  } finally {
    restoreEnv(saved);
  }
}

Deno.test({
  name: "psql engine planning + env helpers (grouped steps; env-sensitive)",
  fn: async (t) => {
    const keysToTouch = [
      "PGHOST",
      "PGPORT",
      "PGUSER",
      "PGDATABASE",
      "PGPASSWORD",
      "DATABASE_URL",
      "PGPASSFILE",
      "PGSERVICEFILE",
      "LOCAL_PGHOST",
      "LOCAL_PGPORT",
      "LOCAL_PGUSER",
      "LOCAL_PGDATABASE",
      "LOCAL_PGPASSWORD",
      "PG_SECRET_JSON",
    ] as const;

    await withTempEnv(keysToTouch, async () => {
      await t.step(
        "catalog + init refs: planInvocation demonstrates multi-engine usage (no execution)",
        async () => {
          const catalog = defineLanguageInitCatalog({
            // PostgreSQL connections
            pg_local: pgInit({
              host: "127.0.0.1",
              port: "5432",
              user: "app",
              dbname: "appdb",
              password: "secret",
            }),
            pg_ro: pgInit({
              host: "db.example.internal",
              port: "5432",
              user: "readonly",
              dbname: "warehouse",
            }),

            // SQLite connections
            sqlite_mem: sqliteInit({ file: ":memory:" }),
            sqlite_file: sqliteInit({ file: "/tmp/example.db" }),

            // DuckDB connections
            duck_mem: duckdbInit({ file: ":memory:" }),
            duck_file: duckdbInit({ file: "/tmp/example.duckdb" }),
          });

          const input = { kind: "text" as const, text: "select 1 as n;" };

          const resolved = psqlEngine.resolveInit({ ref: "pg_local" }, catalog);
          assert(resolved.init);

          const plan = await psqlEngine.planInvocation({
            bin: "psql",
            init: resolved.init,
            input,
            mode: "stdin",
          });

          assertEquals(plan.mode, "stdin");
          assertEquals(plan.argv[0], "psql");

          const argv = plan.argv.join(" ");
          assert(argv.includes("-h 127.0.0.1"));
          assert(argv.includes("-p 5432"));
          assert(argv.includes("-U app"));
          assert(argv.includes("-d appdb"));
          assert(argv.includes("ON_ERROR_STOP=1"));

          const mapped =
            psqlEngine.mapEnv?.({ init: resolved.init, env: {} }) ??
              undefined;
          assertEquals(mapped?.PGPASSWORD, "secret");

          const resolvedSqlite = sqlite3Engine.resolveInit(
            { ref: "sqlite_mem" },
            catalog,
          );
          assert(resolvedSqlite.init);
          const sqlitePlan = await sqlite3Engine.planInvocation({
            bin: "sqlite3",
            init: resolvedSqlite.init,
            input,
            mode: "stdin",
          });
          assertEquals(sqlitePlan.argv[0], "sqlite3");
          assertEquals(sqlitePlan.argv[1], ":memory:");
          assert(sqlitePlan.stdin);

          const resolvedDuck = duckdbEngine.resolveInit(
            { ref: "duck_mem" },
            catalog,
          );
          assert(resolvedDuck.init);
          const duckPlan = await duckdbEngine.planInvocation({
            bin: "duckdb",
            init: resolvedDuck.init,
            input,
            mode: "stdin",
          });
          assertEquals(duckPlan.argv[0], "duckdb");
          assertEquals(duckPlan.argv[1], ":memory:");
          assert(duckPlan.stdin);

          let threw = false;
          try {
            const badCatalog = defineLanguageInitCatalog({
              wrong: sqliteInit({ file: ":memory:" }),
            });
            psqlEngine.resolveInit({ ref: "wrong" }, badCatalog);
          } catch {
            threw = true;
          }
          assertEquals(threw, true);
        },
      );

      await t.step("pgEnv: reads PG* vars (no password by default)", () => {
        Deno.env.set("PGHOST", "127.0.0.1");
        Deno.env.set("PGPORT", "5432");
        Deno.env.set("PGUSER", "app");
        Deno.env.set("PGDATABASE", "appdb");
        Deno.env.set("PGPASSWORD", "should-not-be-read");

        // If your pgEnv() prioritizes DATABASE_URL when present, ensure it is absent here.
        Deno.env.delete("DATABASE_URL");

        const init = pgEnv();
        assertEquals(init.host, "127.0.0.1");
        assertEquals(init.port, "5432");
        assertEquals(init.user, "app");
        assertEquals(init.dbname, "appdb");
        assertEquals(init.password, undefined);
      });

      await t.step(
        "pgEnv: reads prefixed PG* vars (no password by default)",
        () => {
          for (
            const k of [
              "PGHOST",
              "PGPORT",
              "PGUSER",
              "PGDATABASE",
              "PGPASSWORD",
              "DATABASE_URL",
            ] as const
          ) {
            Deno.env.delete(k);
          }

          Deno.env.set("LOCAL_PGHOST", "db.internal");
          Deno.env.set("LOCAL_PGPORT", "5433");
          Deno.env.set("LOCAL_PGUSER", "svc");
          Deno.env.set("LOCAL_PGDATABASE", "warehouse");
          Deno.env.set("LOCAL_PGPASSWORD", "ignored-by-default");

          const init = pgEnv({ prefix: "LOCAL_" });
          assertEquals(init.host, "db.internal");
          assertEquals(init.port, "5433");
          assertEquals(init.user, "svc");
          assertEquals(init.dbname, "warehouse");
          assertEquals(init.password, undefined);
        },
      );

      await t.step("pgEnv: DSN parsing takes precedence when set", () => {
        // DSN should override PG* vars when present.
        Deno.env.set("PGHOST", "should-be-overridden");
        Deno.env.set("DATABASE_URL", "postgresql://u:p@myhost:6543/mydb");

        const init = pgEnv({ readPasswordFromEnv: false });
        assertEquals(init.host, "myhost");
        assertEquals(init.port, "6543");
        assertEquals(init.user, "u");
        assertEquals(init.dbname, "mydb");
        assertEquals(init.password, undefined);
      });

      await t.step(
        "pgPasswordFromPgpass: synthetic pgpass file match + wildcards",
        async () => {
          const pgpass = [
            "# comment",
            "db.internal:5432:warehouse:readonly:ro-pass",
            "*:5432:*:app:app-pass",
            "127.0.0.1:*:*:*:local-any",
          ].join("\n");

          const path = await Deno.makeTempFile({
            prefix: "pgpass-",
            suffix: ".txt",
          });

          try {
            await Deno.writeTextFile(path, pgpass);
            Deno.env.set("PGPASSFILE", path);

            const p1 = await pgPasswordFromPgpass({
              host: "db.internal",
              port: "5432",
              dbname: "warehouse",
              user: "readonly",
            });
            assertEquals(p1, "ro-pass");

            const p2 = await pgPasswordFromPgpass({
              host: "whatever",
              port: "5432",
              dbname: "anything",
              user: "app",
            });
            assertEquals(p2, "app-pass");

            const p3 = await pgPasswordFromPgpass({
              host: "127.0.0.1",
              port: "9999",
              dbname: "x",
              user: "y",
            });
            assertEquals(p3, "local-any");
          } finally {
            try {
              await Deno.remove(path);
            } catch {
              /* ignore */
            }
            Deno.env.delete("PGPASSFILE");
          }
        },
      );

      await t.step(
        "pgServiceFromConf: synthetic pg_service.conf parse",
        async () => {
          const conf = [
            "[warehouse]",
            "host=db.internal",
            "port=5432",
            "user=readonly",
            "dbname=warehouse",
            "",
            "[local]",
            "host=127.0.0.1",
            "port=5432",
            "user=app",
            "dbname=appdb",
          ].join("\n");

          const path = await Deno.makeTempFile({
            prefix: "pgsvc-",
            suffix: ".conf",
          });

          try {
            await Deno.writeTextFile(path, conf);
            Deno.env.set("PGSERVICEFILE", path);

            const svc = await pgServiceFromConf("warehouse");
            assert(svc);
            assertEquals(svc.host, "db.internal");
            assertEquals(svc.port, "5432");
            assertEquals(svc.user, "readonly");
            assertEquals(svc.dbname, "warehouse");
          } finally {
            try {
              await Deno.remove(path);
            } catch {
              /* ignore */
            }
            Deno.env.delete("PGSERVICEFILE");
          }
        },
      );

      await t.step(
        "pgSecretFromJsonEnv + hydratePgInitWithSecrets: fills missing fields",
        async () => {
          const base = {
            host: "db.internal",
            port: "5432",
            user: "app",
            dbname: "appdb",
          };

          Deno.env.set(
            "PG_SECRET_JSON",
            JSON.stringify({
              username: "app",
              password: "supersecret",
              host: "db.internal",
              port: 5432,
              dbname: "appdb",
            }),
          );

          const provider = pgSecretFromJsonEnv("PG_SECRET_JSON");

          const hydrated = await hydratePgInitWithSecrets(base, provider);
          assertEquals(hydrated.host, "db.internal");
          assertEquals(hydrated.port, "5432");
          assertEquals(hydrated.user, "app");
          assertEquals(hydrated.dbname, "appdb");
          assertEquals(hydrated.password, "supersecret");
        },
      );
    });
  },
});
