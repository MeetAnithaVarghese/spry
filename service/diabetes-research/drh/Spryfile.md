---
sqlpage-conf:
  database_url: "sqlite://DRH.cgmdata.sqlite.db?mode=rwc"
  web_root: "./dev-src.auto"
  allow_exec: true
  port: 9227
---

# Diabetes Research Hub (DRH) SQLPage Application

This script automates the conversion of raw diabetes research data (e.g.,
CSV, Parquet, or a private data warehouse export) into a structured SQLite database.

- Uses Spry to manage tasks and generate the SQLPage presentation layer.
- surveilr tool performs csv files conversation and transformation to RSSD
- Uses DuckDB for data transformation.(file meta ingest data,meal fitness data(if present),combined CGM data)
- Export back to sqlite db to be used in SQLpage

## Setup

Download your research data source (based on  the file format mentioned in  https://drh.diabetestechnology.org/organize-cgm-data ) and place it into the same
directory as this `README.md` and then run `spry.ts task prepare-db`. pass the study files folder name in the prepare-db task

```bash prepare-db --descr "Validates ,Extract data , Perform transformations through DuckDB and export to the SQLite database used by SQLPage"
#!/usr/bin/env -S bash
## example usage  ./run-drh-etl-surveilr.sh --data_path raw-data/flexi-cgm-study/ --tenant_id FLCG --tenant_name "FLCG" 
 ./run-drh-etl-surveilr.sh --data_path raw-data/flexi-cgm-study/ --tenant_id FLCG --tenant_name "FLCG" 

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
       'Diabetes Research Data Explorer' AS title,
       NULL AS icon,
       'https://drh.diabetestechnology.org/_astro/favicon.CcrFY5y9.ico' AS favicon,
       'https://drh.diabetestechnology.org/images/diabetic-research-hub-logo.png' AS image,
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
be stored as `assets/brand/*` because the `--base` is `https://drh.diabetestechnology.org`. The `--spc` reminds Spry to include it as part of
the SQLPage content since by default utf8 and other file types don't get
inserted into the stream.

## DRH EDGE  Home Page

Index page which automatically generates links to all `/drh` pages.

```sql drh/index.sql { route: { caption: "DRH Edge UI Home" } }
-- @route.description "Welcome to Diabetes Research Hub Edge UI."

SELECT
      'card'                      as component,
      'Welcome to the Diabetes Research Hub Edge UI' as title,
      1                           as columns;

SELECT
      'About' as title,
      'green'                        as color,
      'white'                  as background_color,
      'The Diabetes Research Hub (DRH) addresses a growing need for a centralized platform to manage and analyze continuous glucose monitor (CGM) data.Our primary focus is to collect data from studies conducted by various researchers. Initially, we are concentrating on gathering CGM data, with plans to collect additional types of data in the future.' as description,
      'home'                 as icon;

SELECT
      'card'                  as component,
      'Files Log' as title,
      1                     as columns;


SELECT
    'Study Files Log'  as title,
    '/drh/ingestion-log/index.sql' as link,
    'This section provides an overview of the files that have been accepted and converted into database format for research purposes' as description,
    'book'                as icon,
    'red'                    as color;

;

SELECT
      'card'                  as component,
      'File Verification Results' as title,
      1                     as columns;

SELECT
    'Verification Log' AS title,
    '/drh/verification-validation-log/index.sql' AS link,
    'Use this section to review the issues identified in the file content and take appropriate corrective actions.' AS description,
    'table' AS icon,
    'red' AS color;



SELECT
      'card'                  as component,
      'Features ' as title,
      9                     as columns;


SELECT
    'Study Participant Dashboard'  as title,
    '/drh/study-participant-dashboard/index.sql' as link,
    'The dashboard presents key study details and participant-specific metrics in a clear, organized table format' as description,
    'table'                as icon,
    'red'                    as color;
;




SELECT
    'Researcher and Associated Information'  as title,
    '/drh/researcher-related-data/index.sql' as link,
    'This section provides detailed information about the individuals , institutions and labs involved in the research study.' as description,
    'book'                as icon,
    'red'                    as color;
;

SELECT
    'Study ResearchSite Details'  as title,
    '/drh/study-related-data/index.sql' as link,
    'This section provides detailed information about the study , and sites involved in the research study.' as description,
    'book'                as icon,
    'red'                    as color;
;

SELECT
    'Participant Demographics'  as title,
    '/drh/participant-related-data/index.sql' as link,
    'This section provides detailed information about the the participants involved in the research study.' as description,
    'book'                as icon,
    'red'                    as color;
;

SELECT
    'Author and Publication Details'  as title,
    '/drh/author-pub-data/index.sql' as link,
    'Information about research publications and the authors involved in the studies are also collected, contributing to the broader understanding and dissemination of research findings.' as description,
     'book' AS icon,
    'red'                    as color;
;



SELECT
    'CGM Meta Data and Associated information'  as title,
    '/drh/cgm-associated-data/index.sql' as link,
    'This section provides detailed information about the CGM device used, the relationship between the participant''s raw CGM tracing file and related metadata, and other pertinent information.' as description,
    'book'                as icon,
    'red'                    as color;

;


SELECT
    'Raw CGM Data Description' AS title,
    '/drh/cgm-data/index.sql' AS link,
    'Explore detailed information about glucose levels over time, including timestamp, and glucose value.' AS description,
    'book'                as icon,
    'red'                    as color;                

SELECT
    'Combined CGM Tracing' AS title,
    '/drh/cgm-combined-data/index.sql' AS link,
    'Explore the comprehensive CGM dataset, integrating glucose monitoring data from all participants for in-depth analysis of glycemic patterns and trends across the study.' AS description,
    'book'                as icon,
    'red'                    as color;         


SELECT
    'PHI De-Identification Results' AS title,
    '/drh/deidentification-log/index.sql' AS link,
    'Explore the results of PHI de-identification and review which columns have been modified.' AS description,
    'book'                as icon,
    'red'                    as color;
;

```