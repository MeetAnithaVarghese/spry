/**
 * factory.ts
 *
 * High-level “wiring” utilities for code-shell.ts: parse a runtime catalog from
 * YAML (or plain objects) and produce a ready-to-use executor bound to a named
 * catalog entry.
 *
 * This module is currently focused on SQL runtimes (psql, sqlite3, duckdb)
 * because those engines are provided by ./sql-shell/mod.ts. The design is
 * intentionally generic: the catalog shape, engine tagging pattern, and the
 * `using()` abstraction are not SQL-specific. As additional LanguageEngines are
 * added (for other languages and runtimes), this factory can expand to map
 * catalog entries to those engines in the same way it does for SQL today.
 *
 * What it provides
 *
 * 1) catalogFromYaml(...)
 *    Converts a YAML string (or already-parsed object) into a
 *    LanguageInitCatalog that is compatible with code-shell.ts engines.
 *
 *    - Accepts either a top-level map of entries or a `catalog:` wrapper node.
 *    - Normalizes env values so they are always string|undefined, matching the
 *      expectations of LanguageInitBase.env.
 *    - Creates engine-tagged init entries using the engine-specific helpers
 *      (pgInit/sqliteInit/duckdbInit). This is important because code-shell.ts
 *      relies on EngineTagged.engineId to prevent mixing init configs across
 *      different runtimes.
 *
 * 2) using(...)
 *    Binds a catalog + entry name into a lightweight executor with a single
 *    spawn() method.
 *
 *    - Resolves the engine from the entry’s engineId.
 *    - Optionally parses a runtime-args string into argv tokens (quoted/escaped).
 *    - Creates (or accepts) a shell.ts instance and wraps it in LanguageSpawnShell.
 *    - Returns a stable object containing: engine, catalog, initRef, runtimeArgs,
 *      and a spawn(input, opts) function that delegates to LanguageSpawnShell.spawn().
 *
 * 3) engineFromCatalogEntry(...) and engineNameFromCatalogEntry(...)
 *    Small helpers to map EngineTagged.engineId back to a concrete engine
 *    instance (and a human-readable name).
 *
 * How to learn this module
 *
 * The best documentation is factory_test.ts. The tests demonstrate the real
 * usage patterns and the edge cases this module is designed to handle:
 *
 * - YAML parsing from both forms:
 *     a) a `catalog:` wrapper object
 *     b) top-level entries without a wrapper
 *
 * - Engine identity tagging:
 *   The tests assert that catalog entries produced by catalogFromYaml have an
 *   engineId matching the concrete engine wrapper helpers (psqlEngine.id,
 *   sqlite3Engine.id, duckdbEngine.id). This is the key invariant that makes
 *   `using()` safe and deterministic.
 *
 * - Env normalization:
 *   The tests verify that env values like numbers/booleans are converted to
 *   strings, and that invalid env shapes throw.
 *
 * - Failure modes:
 *   The tests cover unknown engines, malformed catalog entries, and invalid env
 *   types, showing exactly which inputs are rejected and why.
 *
 * - End-to-end execution:
 *   The tests show `using(catalog, "sqlite1").spawn(...)` executing real SQL
 *   against sqlite3 and (optionally) duckdb, validating that the catalog wiring,
 *   engine resolution, argv planning, and process spawning all work together.
 *
 * In other words: if you want to understand the operational contract of this
 * module, read factory_test.ts first, then read the implementation.
 *
 * @module factory
 */
import { parse as parseYaml } from "@std/yaml";
import {
  defineLanguageInitCatalog,
  type EngineTagged,
  type ExecutionMode,
  type LanguageEngine,
  type LanguageInitBase,
  type LanguageInitCatalog,
  type LanguageInput,
  type LanguageSpawnResult,
  LanguageSpawnShell,
} from "./code-shell.ts";
import { shell as createShell } from "./shell.ts";
import {
  duckdbEngine,
  duckdbInit,
  pgInit,
  psqlEngine,
  sqlite3Engine,
  sqliteInit,
} from "./sql-shell/mod.ts";

/**
 * Parse a YAML catalog definition (or already-parsed object) into a
 * LanguageInitCatalog compatible with code-shell.ts engines.
 *
 * Expected YAML shape (either top-level or nested under `catalog:`):
 *
 * ```yaml
 * catalog:
 *   pg_local:
 *     engine: postgres
 *     host: 127.0.0.1
 *     port: "5432"
 *     user: app
 *     dbname: appdb
 *     # optional:
 *     password: ${NOT_RECOMMENDED_IN_MD}
 *     env:
 *       PGSERVICE: warehouse          # libpq/psql will honor this
 *       PGPASSFILE: /path/to/pgpass   # libpq/psql will honor this
 *
 *   sqlite1:
 *     engine: sqlite
 *     file: ":memory:"
 *
 *   duckdb1:
 *     engine: duckdb
 *     file: ":memory:"
 * ```
 */
export function catalogFromYaml(
  yaml: string | Record<string, unknown>,
  into: LanguageInitCatalog<LanguageInitBase & EngineTagged> = {},
): LanguageInitCatalog<LanguageInitBase & EngineTagged> {
  const root = typeof yaml === "string"
    ? (parseYaml(yaml) as Record<string, unknown> | null)
    : yaml;

  if (!root || typeof root !== "object") {
    throw new Error("catalogFromYaml: YAML did not parse to an object.");
  }

  const catalogNode = (root as Record<string, unknown>).catalog ?? root;
  if (
    !catalogNode || typeof catalogNode !== "object" ||
    Array.isArray(catalogNode)
  ) {
    throw new Error(
      "catalogFromYaml: expected an object at `catalog:` (or top-level).",
    );
  }

  const out = into;

  for (
    const [name, raw] of Object.entries(
      catalogNode as Record<string, unknown>,
    )
  ) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        `catalogFromYaml: catalog entry '${name}' must be an object.`,
      );
    }

    const entry = raw as Record<string, unknown>;
    const engine = String(entry.engine ?? "").toLowerCase();

    const base: LanguageInitBase = {
      bin: typeof entry.bin === "string" ? entry.bin : undefined,
      cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
      env: normalizeEnv(entry.env),
    };

    if (engine === "postgres" || engine === "psql" || engine === "pg") {
      out[name] = pgInit({
        ...base,
        host: asString(entry.host),
        port: asString(entry.port),
        user: asString(entry.user),
        dbname: asString(entry.dbname),
        password: asString(entry.password),
      });
      continue;
    }

    if (engine === "sqlite" || engine === "sqlite3") {
      out[name] = sqliteInit({
        ...base,
        file: asString(entry.file) ?? ":memory:",
      });
      continue;
    }

    if (engine === "duckdb") {
      out[name] = duckdbInit({
        ...base,
        file: asString(entry.file) ?? ":memory:",
      });
      continue;
    }

    throw new Error(
      `catalogFromYaml: entry '${name}' has unknown engine '${engine}'. ` +
        `Expected postgres|sqlite|duckdb.`,
    );
  }

  return defineLanguageInitCatalog(out);
}

function asString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function normalizeEnv(
  v: unknown,
): Record<string, string | undefined> | undefined {
  if (!v) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new Error(
      "catalogFromYaml: env must be an object of key/value pairs.",
    );
  }
  const env: Record<string, string | undefined> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (raw === undefined || raw === null) {
      env[k] = undefined;
    } else if (typeof raw === "string") {
      env[k] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      env[k] = String(raw);
    } else {
      throw new Error(
        `catalogFromYaml: env['${k}'] must be string|number|boolean|null.`,
      );
    }
  }
  return env;
}

export type UsingShell<Baggage = unknown> = {
  readonly kind: "using-shell";
  readonly using: string;
  readonly engine: LanguageEngine;
  readonly catalog: LanguageInitCatalog<LanguageInitBase & EngineTagged>;
  readonly initRef: { ref: string };
  readonly runtimeArgs?: readonly string[];
  spawn(
    input: LanguageInput,
    opts?: {
      mode?: ExecutionMode;
      cwd?: string;
      env?: Record<string, string | undefined>;
      programArgs?: readonly string[];
      baggage?: Baggage;
    },
  ): Promise<LanguageSpawnResult<Baggage>>;
};

export function using<Baggage = unknown>(
  catalog: LanguageInitCatalog<LanguageInitBase & EngineTagged>,
  using: string,
  args?: string,
  init?: {
    shell?: ReturnType<typeof createShell<Baggage>>;
    mode?: ExecutionMode;
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): UsingShell<Baggage> {
  const entry = catalog[using];
  if (!entry) throw new Error(`using(): catalog entry '${using}' not found`);

  const engine = engineFromCatalogEntry(entry);
  const runtimeArgs = args ? splitArgvLine(args) : undefined;

  const sh = init?.shell ?? createShell<Baggage>({
    cwd: init?.cwd,
    env: init?.env,
  });

  const languageShell = new LanguageSpawnShell<Baggage>(sh);

  return {
    kind: "using-shell",
    using,
    engine,
    catalog,
    initRef: { ref: using },
    runtimeArgs,

    spawn: (input, opts) =>
      languageShell.spawn({
        engine,
        catalog,
        init: { ref: using },
        input,
        runtimeArgs,
        mode: opts?.mode ?? init?.mode,
        cwd: opts?.cwd,
        env: opts?.env,
        programArgs: opts?.programArgs,
        baggage: opts?.baggage,
      }),
  };
}

function engineFromCatalogEntry(
  entry: LanguageInitBase & EngineTagged,
): LanguageEngine {
  const id = entry.engineId;
  if (!id) {
    throw new Error(
      "using(): catalog entry is missing engineId; ensure it was created via pgInit/sqliteInit/duckdbInit (or equivalent).",
    );
  }

  if (id === psqlEngine.id) return psqlEngine;
  if (id === sqlite3Engine.id) return sqlite3Engine;
  if (id === duckdbEngine.id) return duckdbEngine;

  throw new Error(
    "using(): catalog entry engineId does not match any known engine (psql/sqlite3/duckdb).",
  );
}

export function engineNameFromCatalogEntry(
  entry: LanguageInitBase & EngineTagged,
): string {
  const id = entry.engineId;

  if (!id) return "unknown";

  if (id === psqlEngine.id) return "postgres";
  if (id === sqlite3Engine.id) return "sqlite";
  if (id === duckdbEngine.id) return "duckdb";

  return "unknown";
}

// Simple quoted argv splitter (same behavior as shell.ts)
function splitArgvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let esc = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch as '"' | "'";
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }

  if (cur) out.push(cur);
  return out;
}
