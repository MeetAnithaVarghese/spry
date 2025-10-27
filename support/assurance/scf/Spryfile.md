---
sqlpage-conf:
  database_url: "sqlite://scf-2025.3.sqlite.db?mode=rwc"
  web_root: "./dev-src.auto"
  allow_exec: true
  port: 9227
---

# Secure Controls Framework (SCF) SQLPage Application

This script automates the conversion of the latest Secure Controls Framework
(SCF) Excel workbook from the
[official SCF GitHub repository](https://github.com/securecontrolsframework/securecontrolsframework)
into a structured SQLite database.

- Uses Spry to manage tasks and generate the SQLPage presentation layer.
- Uses DuckDB with its built-in `excel` and `sqlite` extensions.

## Setup

Download the SCF Excel workbook from the GitHub repo and place it into the same
directory as this `README.md` and then run `spry.ts task prepare-db`. We supply
our own `#!/usr/bin/env -S bash` shebang since we have comments in the shell
script.

```bash prepare-db --descr "Delete and recreate the SQLite database used by SQLPage"
#!/usr/bin/env -S bash
rm -f scf-2025.3.sqlite.db                  # will be re-created by DuckDB `ATTACH`
cat prepare.duckdb.sql | duckdb ":memory:"  # DuckDB processes in memory but creates SQLite DB
```

## SQLPage Dev / Watch mode

While you're developing, Spry's `dev-src.auto` generator should be used:

```bash prepare-sqlpage-dev --descr "Generate the dev-src.auto directory to work in SQLPage dev mode"
./spry.ts spc --fs dev-src.auto --destroy-first --conf sqlpage/sqlpage.json
```

```bash clean --descr "Clean up the project directory's generated artifacts"
rm -rf dev-src.auto
```

In development mode, here’s the `--watch` convenience you can use so that
whenever you update `Spryfile.md`, it regenerates the SQLPage `dev-src.auto`,
which is then picked up automatically by the SQLPage server:

```bash
./spry.ts spc --fs dev-src.auto --destroy-first --conf sqlpage/sqlpage.json --watch --with-sqlpage
```

- `--watch` turns on watching all `--md` files passed in (defaults to
  `Spryfile.md`)
- `--with-sqlpage` starts and stops SQLPage after each build

Restarting SQLPage after each re-generation of dev-src.auto is **not**
necessary, so you can also use `--watch` without `--with-sqlpage` in one
terminal window while keeping the SQLPage server running in another terminal
window.

If you're running SQLPage in another terminal window, use:

```bash
./spry.ts spc --fs dev-src.auto --destroy-first --conf sqlpage/sqlpage.json --watch
```

## SQLPage single database deployment mode

After development is complete, the `dev-src.auto` can be removed and
single-database deployment can be used:

```bash deploy --descr "Generate sqlpage_files table upsert SQL and push them to SQLite"
rm -rf dev-src.auto
./spry.ts spc --package --conf sqlpage/sqlpage.json | sqlite3 scf-2025.3.sqlite.db
```

## Raw SQL

This raw SQL will be placed into HEAD/TAIL.

```sql TAIL --import ../../../lib/universal/schema-info.dml.sqlite.sql
-- this will be replaced by the content of schema-info.dml.sqlite.sql
```

This raw SQL will be placed into HEAD/TAIL. Include as a duplicate of the above
show style-difference between `sql TAIL --import` and `import` which creates
pseudo-cells.

```import --base ../../../lib/universal
sql *.sql TAIL
```

## Layout

This cell instructs Spry to automatically inject the SQL `PARTIAL` into all
SQLPage content cells. The name `global-layout.sql` is not significant (it's
required by Spry but only used for reference), but the `--inject **/*` argument
is how matching occurs. The `--BEGIN` and `--END` comments are not required by
Spry but make it easier to trace where _partial_ injections are occurring.

```sql PARTIAL global-layout.sql --inject **/*
-- BEGIN: PARTIAL global-layout.sql
SELECT 'shell' AS component,
       'Secure Controls Framework (SCF) Explorer' AS title,
       NULL AS icon,
       'https://www.surveilr.com/assets/brand/content-assembler.ico' AS favicon,
       'https://www.surveilr.com/assets/brand/compliance-explorer.png' AS image,
       'fluid' AS layout,
       true AS fixed_top_menu,
       'index.sql' AS link,
       '{"link":"/index.sql","title":"Home"}' AS menu_item;

SET resource_json = sqlpage.read_file_as_text('spry.d/auto/resource/${path}.auto.json');
SET page_title  = json_extract($resource_json, '$.route.caption');
-- END: PARTIAL global-layout.sql
-- this is the `${cell.info}` cell on line ${cell.startLine}
```

Get the brand assets and store them into the SQLPage content stream. They will
be stored as `assets/brand/*` because the `--base` is
`https://www.surveilr.com/`. The `--spc` reminds Spry to include it as part of
the SQLPage content since by default utf8 and other file types don't get
inserted into the stream.

```import --base https://www.surveilr.com/
utf8 https://www.surveilr.com/assets/brand/content-assembler.ico --spc
utf8 https://www.surveilr.com/assets/brand/compliance-explorer.png --spc
```

## SCF Home Page

Index page which automatically generates links to all `/scf` pages.

```sql index.sql { route: { caption: "Home" } }
SET routes_json = sqlpage.read_file_as_text('spry.d/auto/route/forest.auto.json');
SET root_path   = '/scf';

SELECT 'card' AS component, '' AS title, 2 AS columns;
SELECT
  IFNULL(json_extract(c.value,'$.payloads[0].caption'),
         json_extract(c.value,'$.basename'))                         AS title,
  json_extract(c.value,'$.payloads[0].description')                  AS description_md,
  json_extract(c.value,'$.path')                                     AS link
FROM json_each(
       json_extract(
         (SELECT jt.value
          FROM json_tree(json($routes_json)) AS jt
          WHERE jt.type='object'
            AND json_extract(jt.value,'$.path') = $root_path
          LIMIT 1),
         '$.children'
       )
     ) AS c
WHERE IFNULL(json_extract(c.value,'$.virtual'), 0) <> 1;
```

## Unpivoted page

```sql scf/regime_control_unpivoted.sql { route: { caption: "Regime mappings" } }
-- @route.description "One row per (SCF control, regime column) with the raw cell value and regime column ordinal. Use this as the base long-form dataset."

SELECT 'text' AS component, $page_title AS title;

${paginate("scf_regime_control_unpivoted")}

SELECT 'table' AS component,
       TRUE     AS sort,
       'SCF #' as  markdown,
       'Regime' as  markdown,
       TRUE     AS search;  
SELECT
  ${md.link("regime_label", [`'details/regime.sql?regime='`, "regime_label"])} as Regime,
  ${md.link("scf_no", [`'details/regime_control_unpivoted_details.sql?scf_no='`, "scf_no"])} as "SCF #",
  scf_domain AS "SCF Domain",
  scf_control AS "SCF Control",
  scf_control_question AS "SCF Control Question",
  regime_raw_value AS "Regime Marker",
  regime_column_ordinal AS "Regime Column Ordinal"
FROM "scf_regime_control_unpivoted"
ORDER BY scf_no, regime_column_ordinal
${pagination.limit}; 
${pagination.navigation}
```

## Regime Controls page

```sql scf/regime_control.sql { route: { caption: "Clean list of regime mappings"} }
-- @route.description "Filtered projection of the unpivoted data. One row per (SCF control, regime) keeping key control fields and the regime's raw marker."
SELECT
  'text' AS component,
 $page_title AS title;

${paginate("scf_regime_control")}
SELECT 'table' AS component,
       TRUE     AS sort,
       TRUE     AS search,
       'SCF #' as  markdown,
       'Regime' AS markdown;              -- interpret the "Regime" column as Markdown
SELECT  
  ${md.link("scf_no", [`'details/regime_control_unpivoted_details.sql?scf_no='`, "scf_no"])} as "SCF #",
  scf_control AS "SCF Control",
  scf_control_question AS "SCF Control Question",
  regime_raw_value AS "Regime Marker"
FROM "scf_regime_control"
ORDER BY scf_no
${pagination.limit}; 
${pagination.navigation}
```

## Regime Count page

```sql scf/regime_count.sql { route: { caption: "Controls per regime (totals)"} }
-- @route.description "Filtered projection of the unpivoted data. One row per (SCF control, regime) keeping key control fields and the regime's raw marker."
SELECT
  'text' AS component,
 $page_title AS title;

${paginate("scf_regime_count")}

SELECT 'table' AS component,
       TRUE     AS sort,
       'Regime' as  markdown,
       TRUE     AS search;              
SELECT 
  ${md.link("regime", [`'details/regime.sql?regime='`, "regime"])} as Regime,
  control_count AS "Controls"
FROM "scf_regime_count"
ORDER BY control_count DESC, regime
${pagination.limit}; 
${pagination.navigation}
```

## Domain Count page

```sql scf/regime_domain_count.sql { route: { caption: "Domain x Regime counts"} }
-- @route.description "Counts of controls grouped by SCF domain and regime. Useful for heatmaps showing domain coverage by regime."
SELECT
  'text' AS component,
 $page_title AS title;

${paginate("scf_regime_domain_count")}

SELECT 'table' AS component,
       TRUE     AS sort,
       TRUE     AS search;              
SELECT
  domain AS "Domain",
  control_count AS "Controls"
FROM "scf_regime_domain_count"
ORDER BY control_count DESC, domain
${pagination.limit}; 
${pagination.navigation}
```

## Coverage page

```sql scf/regime_domain_coverage.sql { route: { caption: "Domain coverage % by regime"} }
-- @route.description "For each SCF domain and regime, shows mapped control count, total controls in the domain, and the percent coverage."
SELECT
  'text' AS component,
 $page_title AS title;

 ${paginate("scf_regime_domain_coverage")}

SELECT 'table' AS component,
       TRUE     AS sort,
       'Regime' as  markdown,
       TRUE     AS search;              
SELECT
  scf_domain AS "Domain", 
  ${md.link("regime_label", [`'details/regime.sql?regime='`, "regime_label"])} as Regime,
  mapped_controls AS "Mapped Controls",
  domain_total_controls AS "Total Controls",
  coverage_pct AS "Coverage %"
FROM "scf_regime_domain_coverage"
ORDER BY scf_domain, coverage_pct DESC, regime_label
${pagination.limit}; 
${pagination.navigation}
```

## Regime Rank page

```sql scf/regime_domain_rank.sql { route: { caption: "Top regimes within each domain"} }
-- @route.description "Ranks regimes inside each SCF domain by count of mapped controls (ties broken by regime name)."
SELECT
  'text' AS component,
 $page_title AS title;
 
 ${paginate("scf_regime_domain_rank")}

SELECT 'table' AS component,
       TRUE     AS sort,
       'Regime' as  markdown,
       TRUE     AS search;              
SELECT
  scf_domain AS "Domain",   
  ${md.link("regime_label", [`'details/regime.sql?regime='`, "regime_label"])} as Regime,
  control_count AS "Controls",
  regime_rank_in_domain AS "Rank in Domain"
FROM "scf_regime_domain_rank"
ORDER BY scf_domain, regime_rank_in_domain, regime_label
${pagination.limit}; 
${pagination.navigation}
```

## Jaccard page

```sql scf/regime_overlap_jaccard.sql { route: { caption: "Regime overlap (Jaccard)"} }
-- @route.description "Pairwise overlap of regimes based on shared SCF controls, including each regime's total and the Jaccard similarity score."
SELECT
  'text' AS component,
 $page_title AS title;

${paginate("scf_regime_overlap_jaccard")}

SELECT 'table' AS component,
       TRUE     AS sort,
       'Regime A' as  markdown,
       'Regime B' as  markdown,
       TRUE     AS search;              
SELECT 
  ${md.link("regime_a", [`'details/regime.sql?regime='`, "regime_a"])} as "Regime A",
  ${md.link("regime_b", [`'details/regime.sql?regime='`, "regime_b"])} as "Regime B",   
  in_both AS "In Both",
  a_total AS "A Total",
  b_total AS "B Total",
  jaccard AS "Jaccard"
FROM "scf_regime_overlap_jaccard"
ORDER BY jaccard DESC, in_both DESC, regime_a, regime_b
${pagination.limit}; 
${pagination.navigation}
```

```sql scf/details/regime_control_unpivoted_details.sql { route: { caption: "Long form of SCF x Regime mappings details" } }
SELECT
  'text' AS component,
 $page_title||' for SCF # '||$scf_no AS title;

${paginate("scf_regime_control_unpivoted", "WHERE scf_no = $scf_no")}

SELECT 'table' AS component,
       TRUE     AS sort,
       "Regime" as  markdown,
       'SCF #' as  markdown,
       TRUE     AS search;              
SELECT
  ${md.link("regime_label", [`'regime.sql?regime='`, "regime_label"])} as "Regime", 
  ${md.link("scf_no", [`'regime_control_unpivoted_details.sql?scf_no='`, "scf_no"])} as "SCF #",
  scf_domain AS "SCF Domain",
  scf_control AS "SCF Control",
  scf_control_question AS "SCF Control Question",
  regime_raw_value AS "Regime Marker",
  regime_column_ordinal AS "Regime Column Ordinal"
FROM "scf_regime_control_unpivoted"
WHERE scf_no = $scf_no
ORDER BY scf_no, regime_column_ordinal
${pagination.limit}; 
${pagination.navigation}
```

## Controls per regime (totals) details page

```sql scf/details/regime.sql { route: { caption: "Controls per regime (totals) details" } }
SELECT
  'text' AS component,
 $page_title||' for '||$regime AS title;

${paginate("scf_regime_control", "WHERE regime_label = $regime")}

SELECT 'table' AS component,
       TRUE     AS sort,
       "SCF #" as markdown,
       TRUE     AS search;              
SELECT  
  ${md.link("scf_no", [`'regime_control_unpivoted_details.sql?scf_no='`, "scf_no"])} as "SCF #",
  scf_control AS "SCF Control",
  scf_control_question AS "SCF Control Question",
  regime_raw_value AS "Regime Marker"
FROM "scf_regime_control"
WHERE regime_label = $regime
ORDER BY scf_no
${pagination.limit}; 
${pagination.navWithParams("regime")}
```

## Threat Catalog Page

```sql scf/threat_catalog.sql { route: { caption: "Threat Catalog", description: "Threat Catalog" } }
SELECT 'table' as component,
       TRUE as sort,
       TRUE as search;
SELECT
    "Threat Grouping",
    "Threat #",
    "Threat Description",
    "≥ 5% of pre-tax income",
    "≥ 0.5% of total assets",
    "≥ 1% of total equity",
    "≥ 0.5% of total revenue"
FROM scf_threat_catalog;
```

## Controls Library page

```sql scf/controls.sql { route: { caption: "Controls Library"} }
-- @route.description "Discover and understand compliance controls across different regulatory frameworks. Select your applicable regimes to identify your control responsibilities."
SELECT
  'text' AS component,
 $page_title AS title;


 ${paginate("scf_regime_count")}

    SELECT 'table' AS component,
          TRUE     AS sort,
          'Regime' as  markdown,
          TRUE     AS search;              
    SELECT  
      ${md.link("regime", [`'details/regime.sql?regime='`, "regime"])} as Regime,
      control_count AS "Controls"
    FROM "scf_regime_count"
    ORDER BY control_count DESC, regime
    ${pagination.limit}; 
    ${pagination.navigation}
```

## Regime details page

```sql scf/details/regime_details.sql { route: { caption: "Control details" } }
 SELECT 'card' AS component,
           $page_title AS title,
           1 AS columns;
SELECT
      $regime||' '||$scf_no AS title,
      '**SCF Domain:** ' || scf_domain || '  

' ||
      '**SCF Control:** ' || scf_control || '  

' ||
      '**SCF Control Question:** ' || scf_control_question || '  

' ||
      '**Regime Marker:** ' || regime_raw_value 
      AS description_md
  FROM "scf_regime_control_unpivoted"
WHERE scf_no = $scf_no
AND regime_label = $regime;
```
