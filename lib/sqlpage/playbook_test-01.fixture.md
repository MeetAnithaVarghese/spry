---
siteName: Demo
sqlpage-conf:
  database_url: ${env.SPRY_DB ?? "sqlite://app.db"}
  listen_on: "0.0.0.0:8080"
  web_root: "./"
  site_prefix: "/sqlpage"
  https_domain: "example.com"
  host: "example.com"
  allow_exec: true
  max_uploaded_file_size: 1048576
  environment: "development"
  oidc:
    issuer_url: "https://issuer.example/"
    client_id: "abc"
    client_secret: "shh"
env: ${JSON.stringify(env)}
---

## Intro

```bash init
test
```

```sql HEAD
-- head at start
PRAGMA foreign_keys = ON;
```

```sql admin/index.sql { route: { caption: "test" } }
-- route annotations override { route: { ... } }
-- @route.description "This description will be merged into the attributes at the cell level, allowing templating to create route content"

select 1;

-- this is the path: ${path}
-- this is the caption: ${route.caption}
```

```sql users/list.sql
select 2;
-- this is the path: ${path}
-- this is the cell: ${cell?.kind}
-- this is the frontmatter in the cell's notebook: ${safeJsonStringify(cell.frontmatter)}
```

The following cell demonstrates how to partials can use type-safe arguments for
replacement.

```sql PARTIAL test-partial { newLocal: { type: "string", required: true } }
-- this is the ${cell.info} cell on line ${cell.startLine}
-- this is the path in test-partial: ${path}
-- this is the cell in test-partial: ${cell?.kind}
-- this is the partial itself from in test-partial: ${safeJsonStringify(partial)}
-- this is the newLocal in test-partial: ${newLocal}
```

```sql debug.sql
-- markdown link (mdLink): ${md.link("simpleText", "simpleURL")}
-- sqlCat: ${cat`prefix-${"col"}-mid-${"other"}-suffix`}
-- site prefixed: ${ctx.sitePrefixed("test")}

-- partial 1 (error): ${await partial("non-existent")}

-- partial 2 (works): ${await partial("test-partial", { newLocal: "passed from debug.sql"})}

-- partial 3 (error): ${await partial("test-partial", { mistypedNewLocal: "passed from debug.sql"})}

-- partial 4 (without await): ${partial("test-partial", { newLocal: "passed from debug.sql without await"})}

-- full context: add `$` to see... {safeJsonStringify(ctx)}
```

```sql pagination.sql { route: { caption: "Unpivoted" } }
SELECT 'text' AS component, 'Pagination Example' AS title;

${paginate("sqlpage_files")}
SELECT 'table' AS component,
       TRUE     AS sort,
       TRUE     AS search;              
SELECT * FROM "sqlpage_files"
${pagination.limit}; -- needed as part of SELECT for pagination
${pagination.navigation}

${paginate("another_table")}
SELECT 'table' AS component,
       TRUE     AS sort,
       TRUE     AS search;              
SELECT * FROM "another_table"
${pagination.limit}; -- needed as part of SELECT for pagination
${pagination.navigation}
```

The following `PARTIAL` acts as a _layout_ and will be prefixed across every
SQLPage page because `--inject **/*` is supplied. `--prepend` is the default
injection.

The `${path}` will be replaced with the path of the page. `${ctx.*}` are all
state variables like `${ctx.directives}`, `${ctx.routes}`, etc. but the local
page variables are like `${page}`, `${route}`, `${cell}`, etc.

```sql PARTIAL global-layout --inject **/*
-- global LAYOUT (partial)
SET resource_json = sqlpage.read_file_as_text('spry.d/auto/resource/${path}.auto.json');
-- add shell, etc. here
-- this is the `${cell.info}` cell on line ${cell.startLine}
```

The following `PARTIAL` will be prepended (injected) only for the admin paths:

```sql PARTIAL admin-layout --inject admin/**
-- admin/** LAYOUT (partial)
SET resource_json = sqlpage.read_file_as_text('spry.d/auto/resource/${path}.auto.json');
-- add shell, etc. here
```

## Explanation

```sql HEAD
-- head 2, near TAIL
```

```sql TAIL
-- done
```

## Appendix
