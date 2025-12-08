# Spry Playbooks – Operational Service Pattern Framework

Spry Playbooks are operational service patterns expressed in plain Markdown that
become executable, materializable, operational artifacts when processed through
the Spry pipeline:

```
Markdown → mdast → Axiom → semantic graph → projection → playbook runtime
```

A playbook is not just documentation. It is a _programmable operations plan_
describing:

- content,
- behaviors,
- components,
- and emission rules

for a _specific service pattern_ (SQLPage site, runbook workflow, DQ pipeline,
SQL orchestration, etc.).

A playbook is therefore:

- Human-readable (Markdown)
- Machine-actionable (Axiom rules turn it into a graph)
- Service-specific (projection + emitters)
- Deterministic (graph-based reproducibility)
- Composable (imports, partials, fenced behaviors)

The SQLPage playbook is the first operational service pattern implementation,
and its structure informs the general pattern pattern.

# 1. What a Spry Playbook Is

A Spry Playbook:

- Starts as plain Markdown.
- Gains semantics through Axiom edge rules.
- Becomes a projection—the “operating model” for a chosen service.
- Finally emits real artifacts, such as:

  - `.sql` files,
  - SQLite DML,
  - HTML/JS/CSS bundles,
  - JSON spec files,
  - runbook execution steps,
  - SQL execution DAGs,
  - data-quality checks,
  - AI-ready structured knowledge.

Playbooks = Service Patterns Each playbook encodes a pattern for operating a
specific service domain.

# 2. General Playbook Architecture

Across all playbooks, the same conceptual layers apply.

### 2.1 Define

Author Markdown with fenced blocks, frontmatter, decorators, and attributes.

### 2.2 Parse

remark → mdast → Axiom graph enrichment.

### 2.3 Analyze

Axiom rules establish:

- structural edges,
- semantic decorators,
- dependency relationships,
- “belongs to” relationships.

### 2.4 Project

A specialized playbook projection interprets the semantic graph for a service
domain.

Example projections:

- `SqlpagePlaybookProjection`
- `RunbookPlaybookProjection`
- `DataQualityPlaybookProjection`
- `NotebookPlaybookProjection`
- `FolioPlaybookProjection` (for multi-file bundling)
- `EmitterPlaybookProjection` (for templating + materialization)

### 2.5 Emit

Concrete service-specific artifacts. Examples: SQLPage → `.sql` files and SQLite
DML Runbooks → JSON steps + executable instructions DQ → JSON checks, SQL tests,
provenance Spry notebooks → execution graphs + materialized outputs

# 3. SQLPage Playbooks (Reference Example)

SQLPage is the first operational service pattern built with Spry Playbooks.

A SQLPage playbook allows you to maintain an entire SQLPage site using Markdown:

- Fenced blocks define SQL files (`PI` = path)
- Directives (`HEAD`, `TAIL`, `PARTIAL`) encode structural roles
- JSON5 attributes encode:

  - routes,
  - metadata,
  - navigation,
  - layout and injection rules

When projected and emitted, the playbook produces:

- `*.sql` files in real file layout
- SQLPage DML for `sqlpage_files`
- auto-generated route forests
- auto-generated breadcrumbs
- auto-generated partial dumps
- content issue reports

SQLPage becomes a concrete example of a general Spry Playbook:

| Playbook Layer | SQLPage Interpretation                    |
| -------------- | ----------------------------------------- |
| Markdown       | Author content + fences                   |
| Axiom          | Build structure + semantic edges          |
| Projection     | SQLPage-specific representation of blocks |
| Emit           | SQL files + DML + route trees             |

This is the template for all other playbooks.

# 4. Generalizing Beyond SQLPage – “Spry Playbooks” as a Family

SpryMD.org describes multiple patterns—each of these is a playbook.

Below is how each service pattern fits under the playbook model.

## 4.1 Runbook Playbooks

Operational procedures expressed in Markdown become:

- ordered steps
- prerequisite/depends-on edges
- task DAGs
- “task”, “step”, “role”, and “condition” semantics
- execution-ready JSON or CLI actions

Axiom extracts semantics like:

- “Step belongs to section”
- “Decorator @step binds to nearest heading”
- “Code cell tagged as `bash`, `sql`, or `api` becomes executable”

Output: Executable runbooks, CLI-ready step graphs, and service automation
plans.

## 4.2 Data Quality (Spry DQ) Playbooks

Markdown describing datasets, expectations, and validation logic becomes:

- DQ tests,
- DQ suites,
- SQL or JSON checks,
- provenance statements,
- expectation DAGs.

Axiom decorators (`@dataset`, `@column`, `@expect`) map DQ logic to nodes.

Output: Structured DQ specs, SQL test bundles, JSON assertions, provenance
documents.

## 4.3 SQL Pipeline Playbooks

Markdown containing SQL fences and attributes produce:

- SQL execution DAGs
- materialized SQL files
- parameterized templates
- analytics pipelines

Output: Reproducible, documented SQL pipelines.

## 4.4 Notebook (Executable Markdown) Playbooks

Executable code cells in Markdown become:

- ordered execution graphs
- dependency-aware output capture
- storable/emittable artifacts (JSON, text, HTML, SQL, any output)
- provenance trace graphs

Output: A reproducible execution notebook system—_Jupyter-style execution
without a kernel_.

## 4.5 HTML/Vanilla Web Playbooks (assembler successor)

Markdown pages define:

- sections/slots
- imports
- components
- layouts

Projected → emitted as:

- vanilla HTML
- vanilla CSS
- vanilla JS
- asset bundles

This generalizes the old “assembler” concept but with full Axiom semantics.

Output: Lightweight, framework-free, repeatable website bundles.

## 4.6 Compliance / Governance Playbooks

Markdown SOPs, standards, and policies become:

- compliance control trees
- requirement mappings
- relationship graphs
- evidence extraction roots
- audit flows

Output: Machine-verifiable compliance models and documentation.

## 4.7 Knowledge Graph Playbooks

Markdown knowledge documents enriched by decorators become:

- semantic graphs
- AI-ready embeddings
- cross-reference indexes
- linked topic maps

Output: Clean knowledge graphs and semantic indexes for LLM consumption.

# 5. Unified Definition

Spry Playbooks are Markdown-based operational service pattern definitions that
Axiom converts into semantic graphs and Spry converts into operational
artifacts.

Every Playbook = Definition → Graph → Projection → Artifact

SQLPage is simply the first complete implementation of this pattern.

# 6. How to Name Playbooks

We can standardize names using:

```
<domain> Playbook
```

Examples:

- Runbook
- SQLPage Playbook
- Data Quality Playbook
- SQL Pipeline Playbook
- Vanilla Web Playbook
- Compliance Playbook
- Knowledge Playbook

All using the same Axiom-driven semantic model.
