# Spry Self-describing and Idempotent Migrations

Think of Spry migrations as _executable documentation that plans its own changes
using SQL_.

If a developer can read SQL, they can:

- Understand the migration
- Audit what happened
- Re-run it safely
- Extend it without learning a framework

That is the core value of **Spry Idempotent SQL-first Migrations**, with SQLite
shown here as a concrete example. Run it like this:

```bash
# introspection (list tasks)
spry rb ls migrations.spry.md
# for TAP results
spry rb tap migrations.spry.md --style html --save migrations.spry.html
# just CLI
spry rb run migrations.spry.md --verbose rich
# just CLI
spry rb report migrations.spry.md > migrations-report.md
```

This Markdown file is not just documentation. In Spry, it is an **executable
migration plan**.

The key idea is:

- You write **pure SQL** inside Markdown `sql` cells.
- Those SQL cells do not directly mutate the database.
- Instead, they **emit SQL as text** using `SELECT '…';`.
- Spry’s `--recurse` mode feeds that emitted SQL back into the database engine
  as a second pass.
- Because each step is guarded with CTEs, the migration is **idempotent**: safe
  to run repeatedly.

There is no ORM, no migration DSL, no external migration tool. The only things
involved are:

- SQL
- Markdown
- Spry
- The database engine itself (SQLite here)

## Why this works for any database

Spry itself is **database-agnostic**. It does not know or care about SQLite,
Postgres, MySQL, Snowflake, or anything else.

What changes per database is:

- The system catalog tables you query
- The DDL syntax you emit

In this notebook:

- `sqlite_schema`
- `pragma_table_info`
- `sqlite_version()`

are **SQLite-specific**, but the _pattern_ is universal:

- Inspect the catalog
- Decide whether a change is needed
- Emit either APPLY or NOOP SQL

The same approach works for Postgres (`pg_catalog`), MySQL
(`information_schema`), etc.

## Step 1: Declaring the database connection

```yaml CONNECTIONS
spawnables:
  prime:
    engine: sqlite
    file: "prime.sqlite.db"
```

This tells Spry:

- There is a spawnable connection named `prime`
- It uses the SQLite engine
- The database file is `prime.sqlite.db`

Spry uses this information to route SQL execution without embedding connection
logic into your SQL.

## Step 2: Declaring SQL defaults

```code DEFAULTS
sql * --interpolate --injectable -X prime --capture
```

This block sets **execution defaults** for all `sql` cells:

- `-X prime`. Use the `prime` connection by default.
- `--capture`. Capture output instead of discarding it.
- `--recurse` (used later). Take captured output and re-execute it as SQL.
- `--interpolate` / `--injectable`. Allow variable expansion and composition if
  needed.

This is what turns a SQL cell into a **planner** rather than an immediate
mutator.

## Step 3: Generating SQL and "recursing" through what's generated

These `sql` fences emit _strings_ that are valid SQL for a second pass through
`sqlite3` using Spry's `--recurse` functionality, producing a migration that’s
idempotent and self-auditing.

1. **Pass 1 (planning):**. SQL runs and produces text output (comments and SQL
   statements).
2. **Pass 2 (execution):**. That output is executed as SQL.

Spry automates this recursion so you do not need to manage temp files or
scripts.

```sql init
SELECT '-- session: ' || strftime('%Y-%m-%dT%H:%M:%fZ','now');
SELECT '-- sqlite: ' || (SELECT sqlite_version());
```

```sql user-table --recurse --descr "Introduce user table"
WITH need AS (
  SELECT 1 WHERE NOT EXISTS (
    SELECT 1 FROM sqlite_schema WHERE type='table' AND name='user'
  )
)
SELECT '-- APPLY  : create table user' FROM need
UNION ALL
SELECT 'CREATE TABLE IF NOT EXISTS user (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime(''%Y-%m-%dT%H:%M:%fZ'',''now''))
);' FROM need
UNION ALL
SELECT '-- NOOP   : create table user (already exists)'
WHERE NOT EXISTS (SELECT 1 FROM need);
```

```sql user-last_login --recurse --descr "Add last_login column to user table"
WITH need AS (
  SELECT 1 WHERE NOT EXISTS (
    SELECT 1 FROM pragma_table_info('user') WHERE name='last_login'
  )
)
SELECT '-- APPLY  : add column user.last_login' FROM need
UNION ALL
SELECT 'ALTER TABLE user ADD COLUMN last_login TEXT;' FROM need
UNION ALL
SELECT '-- NOOP   : add column user.last_login (already present)'
WHERE NOT EXISTS (SELECT 1 FROM need);
```

```sql user-idx_user_email --recurse --descr "Add idx_user_email index to user table"
WITH need AS (
  SELECT 1
  WHERE NOT EXISTS (
    SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_user_email'
  )
)
SELECT '-- APPLY  : create index idx_user_email on user(email)' FROM need
UNION ALL
SELECT 'CREATE INDEX IF NOT EXISTS idx_user_email ON user(email);' FROM need
UNION ALL
SELECT '-- NOOP   : create index idx_user_email (already exists)'
WHERE NOT EXISTS (SELECT 1 FROM need);
```

The `complex` block shows how to handle **hard migrations** safely:

- You define the desired schema shape as data (`desired` CTE).
- You compare it to the live schema.
- Only if there is a mismatch do you:
  - Rename the table
  - Recreate it
  - Copy data
  - Drop the old table

This is still:

- Pure SQL
- Idempotent
- Fully logged

No special migration framework is required.

```sql complex --recurse --descr "Rebuild user if schema mismatches (planner)"
WITH desired AS (
  SELECT 'id' AS name,'INTEGER' AS type,1 AS pk,1 AS nn,NULL AS dv UNION ALL
  SELECT 'email','TEXT',0,1,NULL UNION ALL
  SELECT 'created_at','TEXT',0,1, (strftime('%Y-%m-%dT%H:%M:%fZ','now')) UNION ALL
  SELECT 'last_login','TEXT',0,0,NULL
),
live AS (
  SELECT name, UPPER(type) AS type, pk, "notnull" AS nn, "dflt_value" AS dv
  FROM pragma_table_info('user')
),
mismatch AS (
  SELECT 1 FROM desired d
  LEFT JOIN live l ON l.name=d.name
  WHERE l.name IS NULL
     OR l.type<>UPPER(d.type)
     OR l.pk<>d.pk OR l.nn<>d.nn
     OR COALESCE(l.dv,')<>COALESCE(d.dv,')
  LIMIT 1
)
SELECT '-- APPLY  : rebuild user (incompatible columns)' FROM mismatch
UNION ALL
SELECT 'ALTER TABLE user RENAME TO user__old;' FROM mismatch
UNION ALL
SELECT 'CREATE TABLE user (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime(''%Y-%m-%dT%H:%M:%fZ'',''now'')),
  last_login TEXT
);' FROM mismatch
UNION ALL
SELECT 'INSERT INTO user (id,email,created_at,last_login)
        SELECT id,email,created_at,last_login FROM user__old;' FROM mismatch
UNION ALL
SELECT 'DROP TABLE user__old;' FROM mismatch
UNION ALL
SELECT '-- NOOP   : rebuild user (schema already matches)'
WHERE NOT EXISTS (SELECT 1 FROM mismatch);
```

```sql finalize
SELECT '-- session: ' || strftime('%Y-%m-%dT%H:%M:%fZ','now');
```

## Appendix: How it works

At the core of this strategy is a simple but powerful idea: **a migration step
should be able to explain its own necessity before it acts**.

What’s happening conceptually is always the same, regardless of database or
complexity.

First, the migration _asks the database a question_. That question is expressed
as a Common Table Expression, often called something like `need`, `plan`, or
`mismatch`. The CTE inspects the system catalog, metadata views, or other
introspection surfaces that the database already provides.

The CTE answers exactly one thing: “Is there a reason to apply this change?”

That reason might be:

- A table does not exist
- A column is missing
- An index is absent
- A constraint differs from what is expected
- A data shape is incompatible
- A set of invariants is violated

Crucially, the CTE does **not** perform any mutation. It is purely diagnostic.

Second, the migration _emits a plan_, not an action. Based on whether the CTE
produces rows, the SQL emits one of two kinds of output:

If the change is needed:

- A human-readable comment explaining what will happen
- One or more SQL statements that would apply the change

If the change is not needed:

- A single NOOP comment explaining why nothing is happening

This output is just text. It is valid SQL text, but at this stage it is still
only a plan.

Third, the emitted SQL is executed as a second pass. Spry’s recursion mechanism
feeds that emitted SQL back into the database engine. Because the emitted SQL
already encodes its own guards and conditions, executing it again is always
safe.

This is why re-running migrations is not a special case. There is no “already
applied” state to manage. Every run recomputes truth from the database itself.

From this pattern, several guarantees naturally fall out.

There is no error on re-run because every mutation is conditional. The database
itself decides whether a change is applicable.

There is clear audit output because every step emits comments describing what it
is doing or why it is not doing anything. The migration log becomes a readable
narrative of intent and outcome.

There is no hidden state because nothing is tracked outside the database and
nothing relies on version tables or migration IDs.

This same pattern works for both simple and complex use cases.

For simple cases, such as creating a table or adding a column, the `need` CTE is
usually a single existence check against the catalog. The emitted SQL is a
single `CREATE` or `ALTER`.

For moderately complex cases, such as index management or constraint
enforcement, the CTE may inspect multiple catalog rows and emit multiple
statements. The structure remains identical: diagnose, then emit either APPLY or
NOOP.

For complex cases, such as schema reconciliation or table rebuilds, the `need`
CTE becomes a planner. It compares a declared “desired state” with the live
state and determines whether they are compatible. If not, it emits a sequence of
DDL and data-movement statements that rebuild the structure safely. Even here,
the migration remains idempotent because the planner will stop emitting rebuild
steps once the live schema matches the desired one.

The important thing to notice is that **complexity grows inside SQL, not around
it**. You do not introduce new tools or abstractions as migrations get harder.
You simply write more expressive SQL.

This is what makes the strategy scale cleanly:

- Simple migrations stay simple.
- Complex migrations remain explicit and inspectable.
- Every migration documents itself as it runs.
- Every migration can be safely re-executed at any time.

In practice, this turns migrations from “one-time scripts you hope never to run
again” into **deterministic programs** whose behavior is entirely derived from
the current state of the database. That is what makes the approach robust for
both early-stage projects and long-lived, evolving systems.
