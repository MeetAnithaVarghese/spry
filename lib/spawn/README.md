# Spry Spawnables

This directory provides a structured, language-agnostic execution framework for
running code, scripts, and commands in a consistent and type-safe way. It is
designed for developer tooling, automation, data workflows, and orchestration
tasks where you want strong typing, predictable behavior, and clear separation
between “what is being run” and “how it is run”.

At a high level, `lib/spawn` lets you define execution environments
declaratively, resolve them from _catalogs_ (for example YAML), and execute
inputs through a uniform API, regardless of whether the underlying runtime is a
database CLI, an operating system shell, or an in-process function.

## Core ideas

The design is based on a few key principles.

First, languages and runtimes are distinct. A language (SQL, shell, env, etc.)
is a semantic concept defined in `lib/universal/code.ts`. A runtime engine is a
concrete way to execute that language, such as `psql`, `sqlite3`, `duckdb`,
`bash`, or an in-process function.

Second, execution planning is separate from execution. Engines do not spawn
processes directly. They produce an invocation plan that describes argv, stdin,
temp files, and cleanup. A single shell implementation is responsible for
actually running processes.

Third, developer-facing APIs should be simple. Most users should not need to
care about argv construction, temp files, or engine identity. They interact with
`factory.ts`, catalogs, and a small spawn API.

## Module overview

### `shell.ts`

`shell.ts` is the lowest-level execution primitive. It is a thin, predictable
wrapper around Deno.Command.

Its responsibilities are intentionally minimal:

- spawn a process given argv and optional stdin
- capture stdout, stderr, exit code, and success
- support small conveniences like shebang execution and text splitting

`shell.ts` knows nothing about languages, SQL, shells, or catalogs. It is a
generic process runner.

### code-shell.ts

`code-shell.ts` defines the orchestration model that sits on top of `shell.ts`.

It introduces:

- `LanguageEngine`: a typed interface for describing how a language runtime
  should be invoked
- Execution modes: `stdin`, `file`, `eval`, and `auto`
- Invocation planning: engines produce argv, stdin, and cleanup instructions
- LanguageSpawnShell: the coordinator that resolves init configuration, selects
  execution mode, calls the engine planner, executes via shell.ts, and performs
  cleanup

This module is intentionally generic. It does not assume SQL, shells, or even
external processes. It is the backbone that everything else builds on.

### function-shell.ts

`function-shell.ts` defines `FunctionEngine`s.

A `FunctionEngine` is a special kind of LanguageEngine that does not spawn an
external process. Instead, it executes logic in-process and returns its result
as STDOUT.

Behavior is usally:

- input is echoed directly to STDOUT or input is only processed in TypeScript
- execution always succeeds unless TypeScript generates exceptions or errors
- stderr is empty or produces exception output from TypeScript

This is used for “special” languages such as `env` and `envrc`, where the goal
is to process or reflect content rather than execute a binary. The engine still
receives the full execution context (cwd, env, input, mode), so richer behavior
can be added later without changing call sites.

From the perspective of `factory.ts` and `LanguageSpawnShell`, `FunctionEngine`s
behave exactly like any other engine.

### `os-shell.ts`

`os-shell.ts` defines engines for operating system shells such as `bash`, `sh`,
`PowerShell`, and `cmd`.

These engines:

- bind shell languages from the language registry (for example “shell” or
  platform-specific variants)
- translate execution modes into shell-appropriate argv forms (for example eval
  vs stdin)
- allow shells to be swapped without changing higher-level logic

The goal is not to abstract away shell semantics, but to make shell usage
consistent and composable within the same execution framework as SQL and
function engines.

### `sql-shell/*`

The `sql-shell` directory contains concrete SQL runtime engines.

`ql-shell/governance.ts` defines shared SQL types and resolves the SQL language
from the language registry.

`ql-shell/postgres.ts` (psqlEngine), `ql-shell/sqlite.ts` (sqlite3Engine), and
`ql-shell/duckdb.ts` (duckdbEngine) each:

- declare supported execution modes
- define how SQL input is passed (stdin vs temp file)
- handle engine-specific flags and environment variables
- tag init objects with engine identity for catalog safety

These engines are intentionally small and explicit. Each one documents how its
runtime behaves and how SQL is delivered to it.

### `factory.ts`

`factory.ts` is the main developer-facing surface of `lib/spawn`.

It is the place where everything comes together.

Its responsibilities are:

- parsing catalogs from YAML or plain objects
- normalizing environment variables and init values
- resolving engines from catalog entries
- constructing LanguageSpawnShell instances
- exposing a simple `using(...)` API that returns a ready-to-use executor

Most developers will only interact with `factory.ts`.

Typical workflow

A typical usage flow looks like this.

1. Define a catalog (YAML or object):

You describe runtimes declaratively. For example, SQL databases, shells, or
function engines.

2. Parse the catalog:

Call `catalogFromYaml(...)` to produce a strongly typed LanguageInitCatalog.

3. Select a runtime:

Use `using(catalog, "name")` to bind a catalog entry to an executable handle.

4. Execute input:

Call `spawn(...)` with `LanguageInput`. The same call shape works for SQL,
shells, and function engines.

The result is always a `LanguageSpawnResult` with STDOUT, STDERR, exit code, and
success.

## Why this design

This module is designed for tooling, automation, and orchestration scenarios
where:

- you want reproducible execution
- you want configuration separated from code
- you want to swap runtimes without rewriting logic
- you want strong typing and testability
- you want a single mental model for “run this thing”

It is not intended to replace interactive shells, ORMs, or full scripting
environments. Instead, it provides a reliable execution substrate that
higher-level systems can build on.

## Learning by tests

The test files in this directory, especially `factory_test.ts`, are the best way
to understand how the system behaves.

They demonstrate:

- catalog parsing rules
- engine resolution
- SQL execution across multiple runtimes
- OS shell invocation
- function engine behavior
- error cases and validation

If you are extending lib/spawn, start by reading the tests. They define the
contract more clearly than any prose.

## Extensibility

The system is intentionally open-ended.

You can add:

- new `LanguageEngine`s for additional runtimes
- richer `FunctionEngines with real processing log`ic
- new catalog loaders
- additional execution modes
- policy and governance layers on top of existing engines

All of this can be done without changing `shell.ts` or the core execution flow.

In short, `lib/spawn` is a composable execution framework. `factory.ts` gives
you a simple entry point, while the underlying modules give you precise control
when you need it.
