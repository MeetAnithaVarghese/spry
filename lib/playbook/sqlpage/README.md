# Spry for SQLPage

Spry lets you maintain a whole SQLPage site from one or more Markdown playbooks:

- You write prose + fenced blocks.
- Special **INFO directives** in the fence header tell Spry what each block is
  (HEAD, TAIL, PARTIAL, injectable PARTIAL, or a concrete SQL file path).
- Optional JSON5 fence attributes annotate things like routes.
- Spry turns your playbook into real `.sql` files (or SQL DML to upsert into
  SQLPage’s virtual file table), plus helpful auto-generated artifacts.

Under the hood this is driven by:

- `lib/sqlpage/playbook.ts` — parses playbooks and emits file entries (and DML).
- `lib/sqlpage/directives.ts` — parses fence `PI` into directives: `HEAD`,
  `TAIL`, `PARTIAL`, or default `sqlpage_file`.
- `lib/sqlpage/route.ts` — validates and renders navigation routes from
  per-block `route` attrs.
- `spry.ts` — the CLI front-end.

## CLI (`spry.ts`)

`spc` stands for SQLPage Content.

```bash
# Windows or Linux/macOS
deno run -A spry.ts spc -m app.md [--fs out/] [-p] [-c sqlpage.json]
deno run -A spry.ts spc -m app.md -p | sqlite3 app.db
deno run -A spry.ts spc -m https://github.com/shah/my-repo/main/app.md ls

# Linux/macOS
./spry.ts spc -m app.md [--fs out/] [-p] [-c sqlpage.json]
./spry.ts spc -m app.md -p | sqlite3 app.db
```

Global option (repeatable):

- `-m, --md <mdPath>`: one or more Markdown sources to load (glob your own list
  if you want). The Markdown path can be either a local file system path or a
  remote URL or a combination. See `--src-rel-to` option to determine how source
  files are resolved if Spry itself is running remotely from a URL vs. locally.

Main behaviors:

- `--fs <dir>` Materialize files to a directory (writes `*.sql` and `spry.d/*`
  alongside).
- `-p, --package` Print **SQLite DML** to stdout that upserts every generated
  file into a `sqlpage_files(path, contents, last_modified)` table (suitable to
  pipe into SQLite). Includes a `CREATE TABLE IF NOT EXISTS` if you pass
  `includeSqlPageFilesTable` (the CLI sets this for you).
- `-c, --conf <path>` Write `sqlpage.json` using the notebook’s frontmatter key
  `sqlpage-conf` (merged/flattened per `conf.ts`).

### `ls` Subcommand

`ls` lists the derived “file entries” by parsing the Markdown but not executing
or preparing any output.

```bash
./spry.ts spc ls -m app.md
./spry.ts spc ls -m app.md --tree
```

You’ll see a table (or a tree with `--tree`) showing:

- **name** (basename) and **kind** `head_sql`, `tail_sql`, or
  `sqlpage_file_upsert`
- **flags** (single-letter indicators)

  - `I` interpolated (a `${…}` template changed the contents)
  - `R` this entry supplies a **route** (from attrs)
  - `A` auto-generated artifact (e.g., route tree dump)
  - `E` error captured (contents are an error payload)
  - `P` a **partial** was applied

### `cat` Subcommand

`cat` prints contents of the derived files matching a glob. Be sure to quote
your globs so the OS shell doesn't intercept and expand the globs.

```bash
./spry.ts spc cat -m app.md -g "admin/*.sql" -g "sql.d/head/*.sql"
```

## Authoring: fence “INFO directives” and attributes

Write fenced blocks in Markdown. The **first token(s)** of the fence “info”
string determines the directive. Anything in `{ … }` at the end of the fence
header is JSON5 attributes (parsed and available to generators).

### HEAD

Inject SQL at the very top of your SQLPage bundle (common `PRAGMA`, helpers,
etc.). Multiple HEAD blocks are emitted as numbered files:

```sql HEAD
-- Shared SQL (runs early)
PRAGMA foreign_keys = ON;
```

Emits: `sql.d/head/0000.sql`, `sql.d/head/0001.sql`, …

### TAIL

Inject SQL at the very end (cleanup, views that depend on prior files, etc.):

```sql TAIL
-- Finalization SQL
SELECT 'bundle complete' AS status;
```

Emits: `sql.d/tail/0000.sql`, `sql.d/tail/0001.sql`, …

### PARTIAL

Define reusable snippets you can interpolate into other blocks via
`${partial('name')}`:

```sql PARTIAL navbar
-- A small nav fragment
SELECT 'Home' AS caption, '/' AS link
UNION ALL
SELECT 'Docs', '/docs';
```

Not written as a standalone file. Referenced during interpolation.

### Auto-injected PARTIAL

Define a wrapper to apply around matched files (by glob). Useful for
headers/footers:

```sql PARTIAL global-layout --inject **/*
--layout:start
/* header for ${path} */
--layout:body
/* footer */
```

When a generated file is injectable-candidate, the body is inserted at
`--layout:body` (here we just concatenate, i.e., `layout + contents`). The
matcher uses glob semantics; the **most specific** partial wins (`cell.ts`
caches and ranks by wildcard count and length).

### Regular SQL files (default: `sqlpage_file`)

If `PI` is not `HEAD|TAIL|PARTIAL`, Spry treats the **first token** as a
**relative path** to write:

```sql admin/index.sql { route: { caption: 'Admin', description: 'Admin landing' } }
-- this block becomes admin/index.sql
SELECT 'Welcome to Admin' AS title;
```

- Path controls the output file: `admin/index.sql`.
- **Attrs** (JSON5) are optional. If you include a `route` object, it’s
  validated (`route.ts`) and used to build a navigation tree and breadcrumbs.

You can mix prose between blocks; Spry ignores it for emission (keep your notes
there).

## Interpolation with `${…}` (`${ctx.*}`, use carefully)

For **regular SQL files**, Spry evaluates the block as a **template literal** to
support simple composition. It provides a context with:

- `partial(name: string)` → the source of a `PARTIAL` of that identity.
- `absURL(sqlClause: string)` and `sitePrefixed(sqlClause: string)` → expands to
  `(COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || <sqlClause>)`
  (handy when you need dynamic site prefixing).
- All fence **attrs** (so you can inline small values).
- The file entry (`path`, `kind`, `cell`, …) if you need them.

Example:

```sql admin/index.sql { site: '/admin' }
-- Apply a layout (auto-injected partial) and a partial; both support interpolation
-- `${partial('navbar')}` injects the code from the PARTIAL above

SELECT ${sitePrefixed(`'${path}'`)} AS base_path;

${partial('navbar')}
```

**Security note:** interpolation uses `eval` of a template string (on purpose,
for power). Treat your playbooks as source code; do not feed untrusted content.

## Routes (navigation) from attrs

Any **regular SQL file** can also declare a route via attrs:

```sql docs/getting-started.sql { route: { caption: 'Getting Started', title: 'Welcome to the docs', description: 'First steps', siblingOrder: 10 } }
SELECT 'Docs' AS section;
```

If you omit `route.path`, Spry defaults it to the fence `PI` path. Route attrs
are validated and enriched with derived fields (basename, dirname, extension(s),
etc.). All routes across your playbooks are assembled into:

- `spry.d/auto/route/forest.auto.json` — a hierarchical forest (all the routes
  in one file).
- `spry.d/auto/route/breadcrumbs.auto.json` — per-path ancestor chains.
- `spry.d/auto/route/edges.auto.json` — graph edges.
- `spry.d/auto/route/tree.auto.txt` — a pretty ASCII tree for humans.

These are marked **auto-generated** in `ls`.

## What gets generated

Running the CLI against your playbook(s) yields a stream of **file entries**;
depending on options you either:

- write them to disk under `--fs`, or
- emit SQLite DML with `-p/--package`.

You’ll typically see:

- `sql.d/head/*.sql` — from `HEAD` fences.
- `sql.d/tail/*.sql` — from `TAIL` fences.
- `admin/index.sql`, `docs/*.sql`, … — from regular SQL fences (`PI` as path).
- `spry.d/auto/resource/<path>.auto.json` — JSON dump of each fence’s **attrs**
  (handy for debugging and automations).
- `spry.d/auto/partial/*.auto.sql` — partial definitions (echoed back so you can
  inspect which matched).
- `spry.d/issues/<provenance>.auto.json` — parse issues (e.g., malformed JSON5
  attrs), if any.
- `spry.d/auto/route/*` — the navigation artifacts above.
- `sqlpage.json` (only if you pass `-c/--conf`) — from frontmatter
  `sqlpage-conf:` keys (see below).

### Frontmatter → `sqlpage.json`

Place this at the top of one of your playbooks:

```yaml
---
sqlpage-conf:
  listen_on: "0.0.0.0:8080"
  site_prefix: "/sqlpage"
  database_url: "sqlite://./db.sqlite"
  oidc:
    issuer_url: "https://auth.example.com"
    client_id: "abc"
    client_secret: "…"
    redirect_path: "/oidc/callback"
---
```

Then run:

```
deno run -A spry.ts -m lib/sqlpage/playbook_test-01.fixture.md -c sqlpage.json
```

Spry validates and **flattens** OIDC fields into what SQLPage expects (e.g.,
`oidc_issuer_url`, etc.), and drops `undefined` keys.

## Example playbook

See [playbook_test-01.fixture.md](playbook_test-01.fixture.md) for a good
starter example.

## Tips & gotchas

- For **regular SQL** fences, always set a valid **path** in the fence `PI`
  (`path.sql`), otherwise Spry will warn and skip.
- Use **JSON5** in attrs (trailing commas are NOT allowed if they break JSON5
  rules — errors will surface in `spry.d/issues/*.auto.json`).
- Keep **partials** small (they’re just text substitution).
- Injected partials' selection prefers **more specific globs** (fewer wildcards,
  longer patterns).
- Interpolation is powerful—use it intentionally; it will mark files with `I` in
  `ls`.
