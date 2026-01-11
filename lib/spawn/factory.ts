/**
 * factory.ts
 *
 * High-level “wiring” utilities for code-shell.ts: parse a runtime catalog from
 * YAML (or plain objects) and produce a ready-to-use executor bound to a named
 * catalog entry.
 *
 * The design is intentionally generic: catalog shape, engine tagging pattern and
 * the `using()` abstraction should accomodate a variety of use cases. As more
 * LanguageEngines are added (for other languages and runtimes), this factory can
 * expand to map catalog entries to those engines.
 *
 * What it provides
 *
 * 1) catalogFromYaml(...)
 *    Converts a YAML string (or already-parsed object) into a
 *    LanguageInitCatalog that is compatible with code-shell.ts engines.
 *
 *    - Accepts either a top-level map of entries or a `spawnables:` wrapper node.
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
 *     a) a `spawnables:` wrapper object
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
import { LanguageSpec } from "../universal/code.ts";
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
import {
  envEngine,
  envInit,
  envrcEngine,
  envrcInit,
} from "./function-shell.ts";
import {
  bashEngine,
  bashInit,
  cmdEngine,
  cmdInit,
  fishEngine,
  fishInit,
  pwshEngine,
  pwshInit,
  shEngine,
  shInit,
  zshEngine,
  zshInit,
} from "./os-shell.ts";
import { shell as createShell } from "./shell.ts";
import {
  duckdbEngine,
  duckdbInit,
  pgInit,
  psqlEngine,
  sqlite3Engine,
  sqliteInit,
} from "./sql-shell/mod.ts";
import {
  surveilrShellEngine,
  SurveilrShellInit,
} from "./sql-shell/surveilr.ts";

/**
 * Parse a YAML catalog definition (or already-parsed object) into a
 * LanguageInitCatalog compatible with code-shell.ts engines.
 *
 * Expected YAML shape (either top-level or nested under `spawnables:`):
 *
 * ```yaml
 * spawnables:
 *   pg_local:
 *     engine: postgres
 *     host: 127.0.0.1
 *     port: "5432"
 *     user: app
 *     dbname: appdb
 *     env:
 *       PGSERVICE: warehouse
 *       PGPASSFILE: /path/to/pgpass
 *
 *   sqlite1:
 *     engine: sqlite
 *     file: ":memory:"
 *
 *   duckdb1:
 *     engine: duckdb
 *     file: ":memory:"
 *
 *   bash1:
 *     engine: bash
 *     # optional:
 *     bin: /usr/local/bin/bash
 *     flags: ["-euo", "pipefail"]  # recommended to keep as separate flags when possible
 *     env:
 *       FOO: bar
 *
 *   pwsh1:
 *     engine: pwsh
 *     harden: true
 *     bypassExecutionPolicy: true
 * ```
 */
export function catalogFromYaml(
  yaml: string | Record<string, unknown>,
  into: LanguageInitCatalog<LanguageInitBase & EngineTagged> = {},
  options?: {
    readonly catalogKey: string;
  },
): LanguageInitCatalog<LanguageInitBase & EngineTagged> {
  const root = typeof yaml === "string"
    ? (parseYaml(yaml) as Record<string, unknown> | null)
    : yaml;

  if (!root || typeof root !== "object") {
    throw new Error("catalogFromYaml: YAML did not parse to an object.");
  }

  const catalogKey = options?.catalogKey ?? "spawnables";
  const catalogNode = (root as Record<string, unknown>)[catalogKey] ?? root;
  if (
    !catalogNode || typeof catalogNode !== "object" ||
    Array.isArray(catalogNode)
  ) {
    throw new Error(
      `catalogFromYaml: expected an object at '${catalogKey}:' (or top-level).`,
    );
  }

  const out = into;

  for (
    const [name, raw] of Object.entries(catalogNode as Record<string, unknown>)
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

    // ----------------------------- function engines -----------------------------

    if (engine === "env") {
      out[name] = envInit({ ...base });
      continue;
    }

    if (engine === "envrc") {
      out[name] = envrcInit({ ...base });
      continue;
    }

    // ----------------------------- SQL engines -----------------------------

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

    if (engine === "surveilr" || engine === "surveilr-shell") {
      out[name] = SurveilrShellInit({
        ...base,
        // match surveilr CLI default; keep configurable
        stateDbFsPath: asString(entry.stateDbFsPath) ??
          asString(entry.state_db_fs_path) ??
          asString(entry.stateDb) ??
          asString(entry.file) ??
          "resource-surveillance.sqlite.db",
        surveilrShellEngine: asString(entry.surveilrShellEngine) as
          | "duckdb"
          | "rusqlite"
          | "rhai"
          | undefined, // rusqlite|duckdb|rhai (surveilr-side)
        cmd: asString(entry.cmd),
        output: asString(entry.output) as "json" | "line" | "table" | undefined, // json|line|table (surveilr-side)
        silent: asBool(entry.silent),
        noObservability: asBool(entry.noObservability) ??
          asBool(entry.no_observability),
        emitSessionId: asBool(entry.emitSessionId) ??
          asBool(entry.emit_session_id),

        // optional extras if your init type supports them
        sqlpkg: asString(entry.sqlpkg),
        sqliteDynExtn: normalizeStringArray(
          entry.sqliteDynExtn ?? entry.sqlite_dyn_extn,
        ),
        importEnv: asString(entry.importEnv) ??
          asString(entry.import_env),
        sessionStateTableName: asString(entry.sessionStateTableName) ??
          asString(entry.session_state_table_name),
        rssdIdentifier: asString(entry.rssdIdentifier) ??
          asString(entry.rssd_identifier),
        rssdAttachSqlStmt: asString(entry.rssdAttachSqlStmt) ??
          asString(entry.rssd_attach_sql_stmt),
        rssdNoAttach: asBool(entry.rssdNoAttach) ??
          asBool(entry.rssd_no_attach),
      });
      continue;
    }

    // -------------------------- OS shell engines ---------------------------

    const flags = normalizeStringArray(entry.flags);

    if (engine === "bash") {
      out[name] = bashInit({ ...base, flags, shell: "bash" });
      continue;
    }

    if (engine === "sh") {
      out[name] = shInit({ ...base, flags, shell: "sh" });
      continue;
    }

    if (engine === "zsh") {
      out[name] = zshInit({ ...base, flags, shell: "zsh" });
      continue;
    }

    if (engine === "fish") {
      out[name] = fishInit({ ...base, flags, shell: "fish" });
      continue;
    }

    if (engine === "pwsh" || engine === "powershell") {
      out[name] = pwshInit({
        ...base,
        flags,
        shell: "pwsh",
        harden: asBool(entry.harden),
        bypassExecutionPolicy: asBool(entry.bypassExecutionPolicy),
      });
      continue;
    }

    if (engine === "cmd") {
      out[name] = cmdInit({ ...base, flags, shell: "cmd" });
      continue;
    }

    throw new Error(
      `catalogFromYaml: entry '${name}' has unknown engine '${engine}'. ` +
        `Expected postgres|sqlite|duckdb|surveilr|bash|sh|zsh|fish|pwsh|cmd.`,
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

function asBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "t", "yes", "y", "1", "on"].includes(s)) return true;
    if (["false", "f", "no", "n", "0", "off"].includes(s)) return false;
  }
  return undefined;
}

function normalizeStringArray(v: unknown): readonly string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    throw new Error("catalogFromYaml: flags must be an array of strings.");
  }
  const out: string[] = [];
  for (const raw of v) {
    const s = asString(raw);
    if (s === undefined) {
      throw new Error("catalogFromYaml: flags entries must be string-like.");
    }
    out.push(s);
  }
  return out.length ? out : undefined;
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

  const sh = init?.shell ?? createShell<Baggage>({
    cwd: init?.cwd,
    env: init?.env,
  });
  const runtimeArgs = args ? sh.splitArgvLine(args) : undefined;

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
      "using(): catalog entry is missing engineId; ensure it was created via an engine init helper (pgInit/sqliteInit/duckdbInit/bashInit/pwshInit/etc).",
    );
  }

  // in-process functions
  if (id === envEngine.id) return envEngine;
  if (id === envrcEngine.id) return envrcEngine;

  // SQL
  if (id === psqlEngine.id) return psqlEngine;
  if (id === sqlite3Engine.id) return sqlite3Engine;
  if (id === duckdbEngine.id) return duckdbEngine;
  if (id === surveilrShellEngine.id) return surveilrShellEngine;

  // OS shells
  if (id === bashEngine.id) return bashEngine;
  if (id === shEngine.id) return shEngine;
  if (id === zshEngine.id) return zshEngine;
  if (id === fishEngine.id) return fishEngine;
  if (id === pwshEngine.id) return pwshEngine;
  if (id === cmdEngine.id) return cmdEngine;

  throw new Error(
    "using(): catalog entry engineId does not match any known engine.",
  );
}

export function engineNameFromCatalogEntry(
  entry: LanguageInitBase & EngineTagged,
): string {
  const id = entry.engineId;

  if (!id) return "unknown";

  // in-process engines
  if (id === envEngine.id) return "env";
  if (id === envrcEngine.id) return "envrc";

  // SQL
  if (id === psqlEngine.id) return "postgres";
  if (id === sqlite3Engine.id) return "sqlite";
  if (id === duckdbEngine.id) return "duckdb";
  if (id === surveilrShellEngine.id) return "surveilr";

  // OS shells
  if (id === bashEngine.id) return "bash";
  if (id === shEngine.id) return "sh";
  if (id === zshEngine.id) return "zsh";
  if (id === fishEngine.id) return "fish";
  if (id === pwshEngine.id) return "pwsh";
  if (id === cmdEngine.id) return "cmd";

  return "unknown";
}

function normalizeLanguageId(ls: string | LanguageSpec): string {
  return typeof ls === "string" ? ls.toLowerCase() : ls.id.toLowerCase();
}

function engineFromLanguageSpec(
  ls: string | LanguageSpec,
): LanguageEngine {
  const key = normalizeLanguageId(ls);

  const engines: readonly LanguageEngine[] = [
    // function engines
    envEngine,
    envrcEngine,

    // SQL engines
    psqlEngine,
    sqlite3Engine,
    duckdbEngine,
    surveilrShellEngine,

    // OS shells
    bashEngine,
    shEngine,
    zshEngine,
    fishEngine,
    pwshEngine,
    cmdEngine,
  ];

  for (const e of engines) {
    if (e.language.id === key) return e;
    if (e.language.aliases?.includes(key)) return e;
  }

  throw new Error(
    `usingLanguage(): unknown language '${key}'`,
  );
}

export function usingLanguage<Baggage = unknown>(
  ls: string | LanguageSpec,
  runtimeArgs?: string[],
  init?: {
    shell?: ReturnType<typeof createShell<Baggage>>;
    mode?: ExecutionMode;
    cwd?: string;
    env?: Record<string, string | undefined>;
    init?: LanguageInitBase;
  },
): UsingShell<Baggage> {
  const engine = engineFromLanguageSpec(ls);

  const sh = init?.shell ?? createShell<Baggage>({
    cwd: init?.cwd,
    env: init?.env,
  });

  const languageShell = new LanguageSpawnShell<Baggage>(sh);

  // Inline init, tagged directly with engineId
  const inlineInit = init?.init
    ? { init: { ...init.init, engineId: engine.id } }
    : undefined;

  const usingName = typeof ls === "string" ? ls : ls.id;

  return {
    kind: "using-shell",
    using: usingName,
    engine,
    catalog: {}, // intentionally empty; no catalog semantics
    initRef: { ref: usingName }, // informational only
    runtimeArgs,

    spawn: (input, opts) =>
      languageShell.spawn({
        engine,
        input,
        init: inlineInit,
        runtimeArgs,
        mode: opts?.mode ?? init?.mode,
        cwd: opts?.cwd,
        env: opts?.env,
        programArgs: opts?.programArgs,
        baggage: opts?.baggage,
      }),
  };
}
