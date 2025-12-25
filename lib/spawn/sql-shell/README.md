# SQL Code Shells

`lib/spawn/sql-shell` is the SQL specialization layer that sits on top of the
generic execution orchestration in `lib/spawn/`code-shell.ts``. The split is
deliberate: `code-shell.ts` owns the uniform execution model and typing, while
sql-shell only provides SQL-specific engines and governance helpers. The net
result is that call sites can execute SQL text or bytes against multiple
runtimes (sqlite3, duckdb, psql) without changing their orchestration code.

## Purpose

What sql-shell “does” at runtime is straightforward. It converts “SQL input plus
optional init plus optional args” into a deterministic, mode-aware CLI
invocation plan, and hands it to LanguageSpawnShell which hands it to
`shell.ts`. The engines make three kinds of decisions: which binary to run
(defaultBins or an overridden bin), which execution mode to use (stdin, file, or
auto selection), and how to shape argv/stdin for that runtime so that the SQL
executes predictably and non-interactively.

The key benefits of this architecture are consistency, testability, and
swap-ability. Call sites depend only on LanguageSpawnShell and a selected
engine. Switching from sqlite3Engine to duckdbEngine or psqlEngine is a one-line
change, not a rewrite. Temporary files are handled centrally and cleaned up
reliably. Output is always captured as bytes. Security-sensitive values can be
injected via mapEnv or external secret providers, keeping catalogs and configs
non-sensitive by default. And because sql-shell is only an engine layer, adding
a new SQL runtime is just “define init type, declare capabilities, implement
planInvocation, provide init tag helper”, with no need to touch `shell.ts` or
the orchestration logic in `code-shell.ts`.

## Architecture

At the bottom is `shell.ts`, which is the only place that actually spawns
processes. It provides spawnArgv, spawnText, spawnShebang, denoTaskEval, and
auto, always returning raw stdout/stderr as Uint8Array plus exit code and
success. `code-shell.ts` wraps `shell.ts` with a language-aware orchestration
layer. It defines the abstraction for a LanguageEngine (a runtime for a given
language) and LanguageSpawnShell (the executor that resolves init config,
chooses an execution mode, plans argv/stdin, and delegates to shell.spawnArgv).

`code-shell.ts` is the contract boundary for “how to run code”. It defines the
types that every language engine must conform to: LanguageInput (text or bytes,
optional filename/extension hints), ExecutionMode (stdin, file, eval, auto),
ModeCapabilities (what a runtime supports), and InvocationPlan (argv, stdin,
optional cleanupPaths). Engines implement planInvocation to translate
LanguageInput plus init values into a concrete InvocationPlan.
LanguageSpawnShell then runs that plan via `shell.ts`, and guarantees cleanup of
any temporary files declared in cleanupPaths.

`sql-shell` is a thin package of engines that bind that generic model to the SQL
language. governance.ts establishes two things: it pins the language to the
registry “sql” via ensureLanguageByIdOrAlias("sql"), and it defines SqlInitBase
as LanguageInitBase plus EngineTagged. That EngineTagged piece is important
because code-shell supports init catalogs, and engine identity tagging prevents
accidentally reusing the wrong init configuration with the wrong runtime. In
other words, you can have multiple SQL engines, and the catalog can safely store
multiple init entries without the risk of cross-wiring them.

Each SQL engine module (`sqlite.ts`, `duckdb.ts`, `postgres.sql`) is a concrete
LanguageEngine for the same sqlLanguage, with a specific CLI runtime and a
specific execution planning strategy.

For `sqlite.ts`, sqlite3Engine declares capabilities { stdin: true, file: true }
and preferredMode "stdin". In stdin mode it runs `sqlite3 <db>` and pipes the
SQL via stdin. In file mode it writes the SQL to a temp file (using
writeTempSource from `code-shell.ts`) and executes a dot-command `.read <file>`.
It also provides sqliteInit() which tags init objects with sqlite3Engine.id so
the init can be stored safely in catalogs.

For `duckdb.ts`, duckdbEngine follows the same pattern: run `duckdb <db>` with
stdin piping when possible, or write a temp file and use `.read <file>` in file
mode. It similarly provides duckdbInit() for engine identity tagging.

For `postgres.sql` (psqlEngine), the engine plans argv using psql flags for
host, port, user, dbname, and forces ON_ERROR_STOP for safer non-interactive
usage. In stdin mode it pipes SQL to psql via stdin. In file mode it writes the
SQL to a temp file and passes `-f <file>`. It also implements mapEnv so that if
a password is provided in init, it injects PGPASSWORD only if it is not already
present. Beyond the engine itself, `postgres.sql` includes operational helpers
for real-world Postgres connection provisioning: reading connection details from
env (pgEnv), building typed catalogs from env (definePgCatalogFromEnv), reading
a password from .pgpass (pgPasswordFromPgpass), reading connection sections from
pg_service.conf (pgServiceFromConf), and “hydrating” partial init objects from
external secret providers (hydratePgInitWithSecrets). The module also includes
secret provider adapters that keep hard dependencies out: a JSON-from-env
provider and a generic fetcher-based provider, so callers can plug in their own
signed fetch logic where needed.
