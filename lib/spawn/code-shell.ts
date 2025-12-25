/**
 * code-shell.ts
 *
 * Language-aware command execution for developer tooling.
 *
 * This module provides a uniform way to execute language-specific programs
 * (SQL, scripts, interpreters, CLIs, etc.) through a consistent, type-safe API.
 * It separates:
 *
 *   - language semantics (from code.ts)
 *   - runtime engines (psql, sqlite3, etc.)
 *   - execution planning (stdin vs file vs eval)
 *   - actual process spawning (via shell.ts)
 *
 * The goal is to make it easy to:
 *   - execute code snippets, files, or generated content
 *   - swap engines without changing call-sites
 *   - support multiple execution modes safely
 *   - keep orchestration logic out of application code
 *
 * -----------------------------------------------------------------------------
 * Core Concepts
 * -----------------------------------------------------------------------------
 *
 * LanguageEngine
 *   A concrete runtime for a language (e.g. SQL via sqlite3 or psql).
 *   Multiple engines may exist for the same language.
 *
 * LanguageSpawnShell
 *   A high-level executor that:
 *     - resolves engine init configuration
 *     - chooses a valid execution mode
 *     - plans argv/stdin
 *     - delegates process execution to shell.ts
 *
 * LanguageInput
 *   The source to execute:
 *     - text (string)
 *     - bytes (Uint8Array)
 *   Optional hints (name / extension) help with temp files when needed.
 *
 * Execution Modes
 *   - stdin : program reads source from STDIN
 *   - file  : source written to temp file and executed
 *   - eval  : engine-specific evaluation mode
 *   - auto  : engine selects the best supported mode
 *
 * -----------------------------------------------------------------------------
 * Typical Usage
 * -----------------------------------------------------------------------------
 *
 * 1. Create a shell instance:
 *
 *   const sh = new LanguageSpawnShell(shell());
 *
 * 2. Choose an engine (e.g. sqlite3Engine):
 *
 *   import { sqlite3Engine } from "../universal/code-shell.ts";
 *
 * 3. Execute language input:
 *
 *   const result = await sh.spawn({
 *     engine: sqlite3Engine,
 *     input: { kind: "text", text: "select 1;" },
 *   });
 *
 *   result.stdout → Uint8Array
 *   result.code   → exit code
 *
 * -----------------------------------------------------------------------------
 * Engine Initialization (optional)
 * -----------------------------------------------------------------------------
 *
 * Engines may accept runtime configuration (database, credentials, etc.).
 * Init values can be:
 *
 *   - provided inline
 *   - referenced from a catalog
 *
 * Example (SQLite):
 *
 *   const catalog = defineLanguageInitCatalog({
 *     mem: sqliteInit({ file: ":memory:" }),
 *   });
 *
 *   sh.spawn({
 *     engine: sqlite3Engine,
 *     init: { ref: "mem" },
 *     catalog,
 *     input: { kind: "text", text: "select 'ok';" },
 *   });
 *
 * -----------------------------------------------------------------------------
 * Adding New Languages
 * -----------------------------------------------------------------------------
 *
 * Languages are registered in code.ts (the LanguageSpec registry). If you need a
 * language that is not already preloaded, add it there:
 *
 *   import { registerLanguage } from "../universal/code.ts";
 *
 *   registerLanguage({
 *     id: "ruby",
 *     aliases: ["rb"],
 *     extensions: [".rb"],
 *     shebangs: ["ruby"],
 *     comment: { line: ["#"], block: [] },
 *   });
 *
 * Once a language exists in the registry, you can attach one or more engines to
 * it using createLanguageEngine() in this module (or your own module).
 *
 * -----------------------------------------------------------------------------
 * Adding New SQL Engines
 * -----------------------------------------------------------------------------
 *
 * SQL engines are just LanguageEngines whose language is the registry "sql"
 * LanguageSpec (ensureLanguageByIdOrAlias("sql")) and whose planInvocation()
 * builds the correct argv/stdin/file strategy for the runtime.
 *
 * Suggested approach:
 *
 * 1. Define an init type for the engine (extend SqlInitBase):
 *
 *   export type DuckDbInit = SqlInitBase & { file?: string };
 *
 * 2. Create the engine (choose bins + supported modes):
 *
 *   const sql = ensureLanguageByIdOrAlias("sql");
 *
 *   export const duckdbEngine = createLanguageEngine<typeof sql, DuckDbInit>({
 *     language: sql,
 *     defaultBins: ["duckdb"],
 *     capabilities: { stdin: true, file: true }, // or eval if supported
 *     preferredMode: "stdin",
 *     planInvocation: async ({ bin, init, input, runtimeArgs, mode }) => {
 *       // Build argv and provide stdin or temp-file execution.
 *       // Return { argv, stdin?, cleanupPaths?, mode }.
 *     },
 *   });
 *
 * 3. Provide a helper to tag init values with engine identity (recommended):
 *
 *   export function duckdbInit(init: Omit<DuckDbInit, "engineId">): DuckDbInit {
 *     return { ...init, engineId: duckdbEngine.id };
 *   }
 *
 * 4. Use it like any other engine:
 *
 *   const sh = new LanguageSpawnShell(shell());
 *   await sh.spawn({
 *     engine: duckdbEngine,
 *     init: { init: duckdbInit({ file: ":memory:" }) },
 *     input: { kind: "text", text: "select 1;" },
 *   });
 *
 * Notes:
 *   - Prefer stdin execution when the runtime supports it cleanly.
 *   - Use file mode when the runtime expects a path or has better semantics for
 *     multi-statement scripts.
 *   - If your engine requires environment variables (passwords, tokens), use
 *     engine.mapEnv() to inject them based on init without leaking into callers.
 *
 * -----------------------------------------------------------------------------
 * When to Use This Module
 * -----------------------------------------------------------------------------
 *
 * Use code-shell.ts when you need:
 *   - programmable execution of code snippets
 *   - tooling pipelines (ETL, migrations, validation, CI helpers)
 *   - language-agnostic orchestration with language-specific runtimes
 *   - strong typing around execution plans and results
 *
 * This module is intentionally orchestration-focused and does not attempt to
 * parse, analyze, or transform code content itself.
 */
import type { LanguageSpec } from "../universal/code.ts";
import { shell as createShell } from "../universal/shell.ts";

/* --------------------------------- Core --------------------------------- */

export type LanguageInitIdentity = string;

export type LanguageInput =
  | { kind: "text"; text: string; hint?: { name?: string; ext?: string } }
  | {
    kind: "bytes";
    bytes: Uint8Array;
    hint?: { name?: string; ext?: string };
  };

export type LanguageSpawnResult<Baggage = unknown> = {
  code: number;
  success: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
  baggage?: Baggage;
  durationMs?: number;
  argv?: readonly string[];
};

export type LanguageInitBase = {
  readonly bin?: string;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
};

/** Optional runtime tag used for catalog safety checks (engine-specific). */
export type EngineTagged = {
  readonly engineId?: object;
};

export type LanguageInitRef<I extends LanguageInitBase = LanguageInitBase> =
  | { ref: LanguageInitIdentity }
  | { init: I };

export type ResolvedInit<I extends LanguageInitBase> = {
  identity?: LanguageInitIdentity;
  init?: I;
};

export type LanguageInitCatalog<I extends LanguageInitBase = LanguageInitBase> =
  Record<LanguageInitIdentity, I>;

export function defineLanguageInitCatalog<const M extends LanguageInitCatalog>(
  m: M,
): M {
  return m;
}

/* ------------------------------ Invocation model ------------------------------ */

export type ExecutionMode = "stdin" | "file" | "eval" | "auto";

export type ModeCapabilities = Readonly<{
  stdin?: true;
  file?: true;
  eval?: true;
}>;

export type InvocationPlan = {
  argv: readonly string[];
  stdin?: Uint8Array;

  // Reserved for a future shell.ts extension (cwd/env per spawn):
  cwd?: string;
  env?: Record<string, string | undefined>;

  cleanupPaths?: readonly string[];
  mode?: Exclude<ExecutionMode, "auto">;
};

export type PlanContext<I extends LanguageInitBase> = {
  bin: string;
  init?: I;
  input: LanguageInput;
  runtimeArgs?: readonly string[];
  programArgs?: readonly string[];
  mode: Exclude<ExecutionMode, "auto">;
};

/* ------------------------------ Engine layer ------------------------------ */

/**
 * A LanguageEngine is a concrete runtime implementation for a LanguageSpec.
 *
 * Multiple engines may share a language (e.g., SQL: psql/sqlite3/duckdb).
 * Engine identity is NOT the language id: it is a distinct runtime marker.
 */
export interface LanguageEngine<
  L extends LanguageSpec = LanguageSpec,
  I extends LanguageInitBase = LanguageInitBase,
> {
  readonly kind: "language-engine";

  /** Language metadata/spec (from content/code.ts registry). */
  readonly language: L;

  /** Engine identity marker (runtime). */
  readonly id: object;

  /** Candidate argv0 values in preference order. */
  readonly defaultBins: readonly string[];

  readonly capabilities: ModeCapabilities;
  readonly preferredMode?: Exclude<ExecutionMode, "auto">;

  resolveInit(
    input: LanguageInitRef<I> | undefined,
    catalog: LanguageInitCatalog<LanguageInitBase & EngineTagged> | undefined,
  ): ResolvedInit<I>;

  planInvocation(ctx: PlanContext<I>): Promise<InvocationPlan> | InvocationPlan;

  mapEnv?(
    init: { init?: I; env?: Record<string, string | undefined> },
  ): Record<string, string | undefined> | undefined;
}

export function createLanguageEngine<
  L extends LanguageSpec,
  I extends LanguageInitBase,
>(
  e: Omit<LanguageEngine<L, I>, "kind" | "resolveInit" | "id"> & {
    id?: object;
    resolveInit?: LanguageEngine<L, I>["resolveInit"];
  },
): LanguageEngine<L, I> {
  const id = e.id ?? {};
  return {
    kind: "language-engine",
    id,
    resolveInit: e.resolveInit ?? defaultResolveInit<I>(id),
    ...e,
  };
}

function defaultResolveInit<I extends LanguageInitBase>(
  engineId: object,
): LanguageEngine<LanguageSpec, I>["resolveInit"] {
  return (input, catalog) => {
    if (!input) return {};
    if ("init" in input) return { init: input.init };

    const identity = input.ref;
    const raw = catalog?.[identity];
    if (!raw) return { identity, init: undefined };

    if (raw.engineId !== undefined && raw.engineId !== engineId) {
      throw new Error(
        `Init '${identity}' has different engine identity than the requested engine.`,
      );
    }

    // Safe because caller controls catalog; engineId check above protects mixing.
    return { identity, init: raw as unknown as I };
  };
}

/* ------------------------------- Shell layer ------------------------------ */

export type LanguageSpawnRequest<
  Baggage,
  E extends LanguageEngine<LanguageSpec, LanguageInitBase>,
> = {
  engine: E;
  input: LanguageInput;

  catalog?: LanguageInitCatalog<LanguageInitBase & EngineTagged>;

  init?: LanguageInitRef<
    E extends LanguageEngine<LanguageSpec, infer I> ? I : LanguageInitBase
  >;

  bin?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;

  runtimeArgs?: readonly string[];
  programArgs?: readonly string[];

  mode?: ExecutionMode;

  baggage?: Baggage;
};

export interface LanguageShell<Baggage = unknown> {
  readonly kind: "language-shell";
  readonly shell: ReturnType<typeof createShell<Baggage>>;
  spawn<E extends LanguageEngine<LanguageSpec, LanguageInitBase>>(
    req: LanguageSpawnRequest<Baggage, E>,
  ): Promise<LanguageSpawnResult<Baggage>>;
}

export class LanguageSpawnShell<Baggage = unknown>
  implements LanguageShell<Baggage> {
  readonly kind = "language-shell" as const;

  constructor(readonly shell: ReturnType<typeof createShell<Baggage>>) {}

  async spawn<E extends LanguageEngine<LanguageSpec, LanguageInitBase>>(
    req: LanguageSpawnRequest<Baggage, E>,
  ): Promise<LanguageSpawnResult<Baggage>> {
    type I = E extends LanguageEngine<LanguageSpec, infer X> ? X
      : LanguageInitBase;

    const resolved = req.engine.resolveInit(
      req.init as LanguageInitRef<I> | undefined,
      req.catalog,
    );

    const init = resolved.init;

    const bin = resolveBin(req.bin, init?.bin, req.engine.defaultBins);

    // NOTE: shell.ts applies cwd/env from shell construction time.
    // Keep these for future extension / validation only.
    const _cwd = req.cwd ?? init?.cwd;

    const baseEnv = mergeEnvMaps(init?.env, req.env);
    const mapped = req.engine.mapEnv?.({ init, env: baseEnv }) ?? undefined;
    const _env = mergeEnvMaps(baseEnv, mapped);

    const mode = chooseMode({
      requested: req.mode ?? "auto",
      capabilities: req.engine.capabilities,
      preferred: req.engine.preferredMode,
    });

    const plan = await req.engine.planInvocation({
      bin,
      init,
      input: req.input,
      runtimeArgs: req.runtimeArgs,
      programArgs: req.programArgs,
      mode,
    });

    // plan.env/plan.cwd are reserved for a future shell.ts extension.
    // const _planEnv = mergeEnvMaps(_env, plan.env);
    // const _planCwd = plan.cwd ?? _cwd;

    try {
      const result = await this.shell.spawnArgv(
        plan.argv,
        plan.stdin,
        req.baggage,
      );
      return { ...result, argv: plan.argv };
    } finally {
      const cleanup = plan.cleanupPaths ?? [];
      for (const p of cleanup) {
        try {
          await Deno.remove(p);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function resolveBin(
  reqBin: string | undefined,
  initBin: string | undefined,
  defaults: readonly string[],
): string {
  return reqBin ?? initBin ?? defaults[0] ?? "";
}

function chooseMode(init: {
  requested: ExecutionMode;
  capabilities: ModeCapabilities;
  preferred?: Exclude<ExecutionMode, "auto">;
}): Exclude<ExecutionMode, "auto"> {
  const caps = init.capabilities;

  const supported = (m: Exclude<ExecutionMode, "auto">) =>
    (m === "stdin" && !!caps.stdin) ||
    (m === "file" && !!caps.file) ||
    (m === "eval" && !!caps.eval);

  if (init.requested !== "auto") {
    if (!supported(init.requested)) {
      throw new Error(`Engine does not support mode '${init.requested}'.`);
    }
    return init.requested;
  }

  if (init.preferred && supported(init.preferred)) return init.preferred;

  if (caps.stdin) return "stdin";
  if (caps.eval) return "eval";
  if (caps.file) return "file";

  throw new Error("Engine has no supported execution modes.");
}

/* ----------------------------- Source utilities ---------------------------- */

export function toStdinBytes(input: LanguageInput): Uint8Array {
  return input.kind === "bytes"
    ? input.bytes
    : new TextEncoder().encode(input.text);
}

export async function writeTempSource(
  input: LanguageInput,
  suffix: string,
): Promise<string> {
  const path = await Deno.makeTempFile({ prefix: "src-", suffix });
  if (input.kind === "text") await Deno.writeTextFile(path, input.text);
  else await Deno.writeFile(path, input.bytes);
  return path;
}

/** Pick suffix from input.hint.ext, else from language extensions, else fallback. */
export function suggestedSuffixFromLanguage(
  input: LanguageInput,
  language: LanguageSpec,
  fallback: string,
): string {
  const hint = input.hint?.ext;
  if (hint && hint.startsWith(".")) return hint;
  if (hint) return `.${hint}`;

  const ext0 = language.extensions?.[0];
  if (ext0) return ext0.startsWith(".") ? ext0 : `.${ext0}`;

  return fallback;
}

export function mergeEnvMaps(
  a?: Record<string, string | undefined>,
  b?: Record<string, string | undefined>,
): Record<string, string | undefined> | undefined {
  if (!a && !b) return undefined;
  return { ...(a ?? {}), ...(b ?? {}) };
}
