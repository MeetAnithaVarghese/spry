---
doc-classify:
  - select: heading[depth="1"]
    role: project
  - select: heading[depth="2"]
    role: strategy
  - select: heading[depth="3"]
    role: plan
  - select: heading[depth="4"]
    role: suite
  - select: heading[depth="5"]
    role: case
  - select: heading[depth="6"]
    role: evidence
---

# Spry remark ecosystem Test Fixture 01

@id mdast-io-project

This synthetic project exists **only** to exercise the full mdast-io and Spry
remark plugin stack end-to-end. It is intentionally dense and over-documented so
that:

- `remark` can parse the Markdown into an MDAST tree.
- **Spry’s remark plugins** can:
  - classify nodes by role,
  - attach identities,
  - parse document and heading frontmatter,
  - decorate code fences with annotations and frontmatter,
  - stitch partial code cells together,
  - inject external and internal content,
  - validate structured schemas derived from Markdown.
- `mdast-io` and related libraries can serialize, re-hydrate, and round-trip
  this tree without losing any structural or semantic information.

Although this file is synthetic, it is **designed as a comprehensive test
fixture** for:

- `mdast-io` read/write behavior,
- the Spry MDAST notebook/runtime pipelines,
- pipeline orchestration in Deno / TypeScript test suites.

**Objectives**

- Demonstrate how **doc frontmatter** is parsed and attached to the `Root` node.
- Show how the **doc schema plugin** validates that frontmatter against a
  schema.
- Exercise **heading frontmatter** that targets headings via selectors.
- Exercise **node classification** using the `doc-classify` rules above.
- Demonstrate **node identities** via `@id` markers and cross-references.
- Use **code annotations** (info string metadata) and **code frontmatter**
  within fences to provide rich, typed metadata for executable cells.
- Demonstrate **code partial** authoring and composition.
- Demonstrate **code injection** from:
  - other cells within this document, and
  - hypothetical external sources.
- Provide realistic “test strategy / plan / suite / case / evidence” structures
  that map nicely to MDAST node graphs.

**Risks**

- Loss of identity or metadata when serializing/deserializing with `mdast-io`.
- Incorrect or incomplete application of `doc-classify` rules to headings.
- Plugins executing in the wrong order, causing:
  - schema validation to run before classification,
  - code injection to run before partials are registered, etc.
- Code annotations being mis-parsed or mis-typed by the plugin pipeline.
- Ambiguous or duplicated `@id` values causing node identity collisions.
- Heading frontmatter colliding with doc frontmatter when merged into one
  schema.
- Partial composition or code injection forming cycles or invalid DAGs.
- Evidence nodes not being recognized as `role: evidence` by classification
  logic.

---

## Plugin Orchestration Strategy

@id plugin-orchestration-strategy

This section explains the **high-level strategy** for exercising the entire Spry
plugin stack on a single Markdown document processed by `remark` and `mdast-io`.

The following Spry remark plugins are assumed to run, in a pipeline, on this
file:

1. **Doc frontmatter plugin**
2. **Heading frontmatter plugin**
3. **Node classification plugin**
4. **Node identities plugin**
5. **Code annotations plugin**
6. **Code frontmatter plugin**
7. **Code partial plugin**
8. **Code injection plugin**
9. **Doc schema plugin** (validation near the end)

Each subsequent section includes specific test plans and cases that ensure
behavior from all of the above plugins is visible and verifiable in the final
MDAST.

**Key Goals**

- Confirm that the plugin ordering is correct and produces stable, predictable
  annotations.
- Validate that every plugin leaves observable traces in the MDAST so that
  automated tests can assert on them.
- Ensure that `mdast-io` can serialize these trees with **lossless** metadata
  round-trips (via data attributes, custom fields, or embedded JSON).

---

## Node Classification & Doc Frontmatter Strategy

@id classification-strategy

This section validates that the **doc frontmatter plugin** correctly initializes
document-level metadata and that the **node classification plugin** applies the
`doc-classify` rules from the YAML block at the top of this file.

**Doc Frontmatter Plugin Behavior**

- Reads YAML block at the very top (`--- ... ---`).
- Attaches it as `root.data.frontmatter`.
- Makes `doc-classify` rules available to subsequent plugins.

**Node Classification Plugin Behavior**

- Reads `root.data.frontmatter.doc-classify`.
- Applies CSS-like selectors to the MDAST:

  - `h1` → `role: project`
  - `h2` → `role: strategy`
  - `h3` → `role: plan`
  - `h4` → `role: suite`
  - `h5` → `role: case`
  - `h6` → `role: evidence`
- Writes computed roles into each heading node, e.g. `node.data.role = "suite"`
  for `h4`.

### Node Classification Verification Plan

@id classification-plan

**Cycle Goals**

- Ensure every heading receives the correct `role`.
- Confirm that nested suites/cases/evidence remain correctly classified.
- Verify that classification is preserved after `mdast-io` serialization.

#### Node Classification Visibility Suite

@id classification-visibility-suite

Ensures classification metadata is present and queryable for multiple heading
levels.

**Scope**

- All headings (`h1`–`h6`) in this file.
- Nested sections that emulate project/strategy/plan/suite/case/evidence.

##### Verify headings are classified according to doc frontmatter rules

@id TC-CLASSIFY-0001

```yaml HFM
doc-classify:
  role: case
requirementID: REQ-CLASSIFY-001
Priority: High
Tags: [mdast-io, classification, doc-frontmatter]
Scenario Type: Happy Path
```

**Description**

Verify that the node classification plugin uses `doc-classify` rules to enrich
heading nodes with a `role` field in their `data` property.

**Preconditions**

- [x] Doc frontmatter plugin is enabled and runs before node classification.
- [x] Node classification plugin is enabled.
- [x] MDAST tree is available to assertions (via `mdast-io`).

**Steps**

- [x] Process this Markdown file through the configured remark pipeline.
- [x] Locate all heading nodes (`depth` 1–6).
- [x] Check their `data.role` properties.
- [x] Correlate `depth` with expected role (`project`, `strategy`, `plan`,
      `suite`, `case`, `evidence`).

**Expected Results**

- [x] Every heading has a `data.role` value.
- [x] `h1` is tagged as `project`, `h2` as `strategy`, `h3` as `plan`, etc.
- [x] No headings are left unclassified.
- [x] Classification metadata is serialized and preserved by `mdast-io`.

###### Evidence

@id TC-CLASSIFY-0001

```yaml HFM
doc-classify:
  role: evidence
cycle: 1.0
assignee: synthetic-bot
status: passed
```

**Attachment**

- [Results JSON](./evidence/TC-CLASSIFY-0001/1.0/result.auto.json)
- [MDAST dump](./evidence/TC-CLASSIFY-0001/1.0/mdast.auto.json)
- [Run MD](./evidence/TC-CLASSIFY-0001/1.0/run.auto.md)

---

## Node Identities & Heading Frontmatter Strategy

@id identities-strategy

This section validates that **node identities** and **heading frontmatter
plugin** cooperate cleanly:

- `@id` markers in paragraphs directly under headings are used by the node
  identities plugin to set stable internal IDs.
- Heading frontmatter (YAML blocks immediately following headings) provides
  per-section metadata that the doc schema plugin can validate.

### Node Identity & Heading Frontmatter Plan

The following `YAML` should get "attached" to the mdast "Node Identity & Heading
Frontmatter Plan" heading because it's `yaml` marked as `HFM` and be classified
as a "requirement" with tags "one" and "two".

@id identities-plan

```yaml HFM
doc-classify:
  role: requirement
tags: ["one", "two"]
```

**Cycle Goals**

- Map every `@id` marker (e.g. `@id mdast-io-project`) to a corresponding
  `node.data.headFM.id`.
- Ensure that heading frontmatter blocks are attached to headings rather than
  body content.
- Validate that node identities are unique and consistent across traversals.

#### Node Identity Suite

@id identities-suite

##### Verify @id markers bind to nearest semantic node

@id TC-ID-0001

```yaml HFM
doc-classify:
  role: case
requirementID: REQ-ID-001
Priority: High
Tags: [node-identities, heading-frontmatter]
Scenario Type: Happy Path
```

**Description**

Ensure that the node identities plugin recognizes `@id` markers and assigns
stable identifiers to the nearest enclosing logical node (heading section, code
cell, etc.).

**Preconditions**

- [x] Node identities plugin is enabled.
- [x] `@id` markers appear on their own lines within paragraphs.

**Steps**

- [x] Process this file and traverse all nodes that have an `@id` marker in
      their textual content.
- [x] Confirm that associated nodes have `data.id` reflecting that value.
- [x] Ensure that multiple references to the same `@id` point to the same
      logical node.

**Expected Results**

- [x] Each unique `@id` value corresponds to exactly one primary node.
- [x] Duplicate `@id` usage is detectable and can be flagged by tests.
- [x] Heading frontmatter for such nodes is accessible via
      `heading.data.frontmatter`.

###### Evidence

@id TC-ID-0001

```yaml HFM
doc-classify:
  role: evidence
cycle: 1.0
assignee: synthetic-bot
status: passed
```

**Attachment**

- [MDAST IDs dump](./evidence/TC-ID-0001/1.0/mdast-ids.auto.json)

---

## Code Annotations & Code Frontmatter Strategy

@id code-metadata-strategy

This section demonstrates how **code annotations** and **code frontmatter**
augment fenced code blocks with **typed metadata** and how `mdast-io` persists
that metadata.

The **code annotations plugin**:

- Parses the info string (e.g. `ts HFM or`yaml HFM).
- Extracts:

  - language (`ts`, `yaml`, `bash`, etc.),
  - annotation tags (`HFM`, `partial`, `inject`, etc.),
  - optional key=value pairs for more structured hints.
- Stores these as `node.data.annotations`.

The **code frontmatter plugin**:

- Reads a leading YAML block **inside** the code fence.
- Treats that YAML as metadata specific to this code cell.
- Attaches parsed metadata to `node.data.frontmatter`.

### Code Metadata Verification Plan

@id code-metadata-plan

#### Code Metadata Suite

@id code-metadata-suite

##### Verify code annotations and code frontmatter are both attached

@id TC-CODEMETA-0001

```yaml HFM
doc-classify:
  role: case
requirementID: REQ-CODEMETA-001
Priority: High
Tags: [code-annotations, code-frontmatter, mdast-io]
Scenario Type: Happy Path
```

**Description**

Validate that both code annotations (from info string) and code frontmatter
(from in-fence YAML) are attached to a single code node without conflicts.

**Synthetic Example Code Cell**

```ts ts-example-01 partial id=sample-code-meta
---
cell:
  id: sample-code-meta
  purpose: "Demonstrate combined annotations and frontmatter"
  artifacts:
    - "compiled-js"
    - "execution-log"
---
/**
 * This code cell is synthetic and will never run in production.
 * It exists purely to test Spry's code metadata handling.
 */
export function sampleCodeMeta() {
  console.log("hello from sampleCodeMeta");
}
```

**Preconditions**

- [x] Code annotations plugin is enabled.
- [x] Code frontmatter plugin is enabled.
- [x] Code partial plugin is enabled but not yet applied to this cell in tests.

**Steps**

- [x] Process this file through the plugin pipeline.
- [x] Locate the `sample-code-meta` node using node identities or search.
- [x] Assert that `node.data.annotations` includes:

  - `language: "ts"`,
  - `tags: ["HFM", "partial"]`,
  - `id: "sample-code-meta"`.
- [x] Assert that `node.data.frontmatter.cell.id == "sample-code-meta"`.

**Expected Results**

- [x] Both annotation metadata and frontmatter metadata are present.
- [x] No data is overwritten or lost between plugins.
- [x] `mdast-io` preserves these fields across serialization.

###### Evidence

@id TC-CODEMETA-0001

```yaml HFM
doc-classify:
  role: special-evidence
cycle: 1.0
assignee: synthetic-bot
status: passed
```

---

## Code Partials & Code Injection Strategy

@id code-partials-injection-strategy

This section focuses on how **code partial plugin** and **code injection
plugin** work together:

- The **code partial plugin**:

  - Treats some code cells as reusable “partials” based on annotations and
    frontmatter.
  - Registers them in an index keyed by `cell.id` or `@id`.

- The **code injection plugin**:

  - Resolves injection directives referring to those partials or external
    sources.
  - Materializes composite code cells or synthetic MDAST nodes.

### Partial & Injection Plan

@id code-partials-injection-plan

#### Partial Library Suite

@id code-partials-suite

This suite builds a small library of partials that can be injected in multiple
ways.

##### Define a reusable TypeScript partial

@id TC-PARTIAL-0001

```ts PARTIAL TC-PARTIAL-0001
// TODO: be sure this works
// this is a TypeScript comment which will be read stored as a partial so that
// it can be "included" in another cell or markdown body using ::PARTIAL[TC-PARTIAL-0001] later
```

##### Define a reusable Markdown partial for use with directives

```md PARTIAL TC-PARTIAL-0001
This markdown was inserted from the PARTIAL named TC-PARTIAL-0001
```

##### Inject the partial into another cell by logical ID

@id TC-INJECT-0001

```csv --import ./sundry/group1-patients.csv
This is a code block whose content will be replaced with the imported CSV.
```

**Description**

`TC-PARTIAL-0001` defines a partial; `TC-INJECT-0001` describes an injection
that should resolve to that partial in the MDAST graph.

**Preconditions**

- [x] Code partial plugin runs before code injection plugin.
- [x] Node identities plugin has attached IDs to these code cells.

**Steps**

- [x] Process the file through the plugin pipeline.
- [x] Using the code partial plugin’s index, confirm that `helper-fn` exists.
- [x] Inspect the injected cell (`inject-usage-01`).
- [x] Confirm it has `data.injection.sourceId == "helper-fn"` and that the code
      injection plugin has either:

  - materialized a composed code node, or
  - prepared enough metadata for runtime composition.

**Expected Results**

- [x] Partials are discoverable by ID.
- [x] Injection references resolve successfully.
- [x] Cycles or missing partials are detectable in tests.

###### Evidence

@id TC-INJECT-0001-EVIDENCE

```yaml HFM
doc-classify:
  role: evidence
cycle: 1.0
assignee: synthetic-bot
status: passed
```

---

## Doc Schema Strategy

@id doc-schema-strategy

The **doc schema plugin** validates that the aggregated frontmatter (document,
heading, and code-level) conforms to schemas defined in configuration or
embedded inside the file.

This fixture ensures:

- Multiple schemas are present (for project, suites, cases).
- Validation failures appear as structured errors that tests can assert against.

### Doc Schema Validation Plan

@id doc-schema-plan

#### Schema Compliance Suite

@id schema-suite

##### Validate project-level schema

@id TC-SCHEMA-0001

```yaml HFM
doc-classify:
  role: case
requirementID: REQ-SCHEMA-001
Priority: High
Tags: [doc-schema, frontmatter]
Scenario Type: Happy Path
schema:
  type: object
  required: [doc-classify]
```

**Description**

Ensure that the document’s root frontmatter satisfies the minimal schema
requirements for `mdast-io` integration tests.

**Preconditions**

- [x] Doc schema plugin is enabled.
- [x] Schemas are configured to apply to `root` nodes.

**Steps**

- [x] Process the Markdown file.
- [x] Run schema validation against `root.data.frontmatter`.
- [x] Capture any validation errors.

**Expected Results**

- [x] Validation passes for required fields (e.g. `doc-classify`).
- [x] Validation results are made available via `root.data.schemaValidation`.

###### Evidence

@id TC-SCHEMA-0001

```yaml HFM
doc-classify:
  role: evidence
cycle: 1.0
assignee: synthetic-bot
status: passed
```

---

## mdast-io Round-Trip Strategy

@id mdast-io-roundtrip-strategy

This logico-technical section describes how `mdast-io` is expected to handle the
richly annotated MDAST tree derived from this Markdown:

- Read the document from disk or another source (`mdast-io` read path).
- Process through the remark + Spry plugin pipeline.
- Serialize the resulting tree to JSON or another intermediate format.
- Rehydrate it back into a MDAST tree.
- Confirm that:

  - node identities,
  - classification roles,
  - annotations,
  - frontmatter,
  - partials,
  - injection metadata,
  - schema validation results are all preserved.

### mdast-io Round-Trip Plan

@id mdast-io-roundtrip-plan

#### Round-Trip Integrity Suite

@id roundtrip-suite

##### Verify mdast-io preserves plugin metadata across round-trip

@id TC-RNDTRIP-0001

```yaml HFM
doc-classify:
  role: case
requirementID: REQ-RNDTRIP-001
Priority: High
Tags: [mdast-io, roundtrip, metadata]
Scenario Type: Happy Path
```

**Description**

Ensure that `mdast-io` can read and write the annotated MDAST tree derived from
this file without dropping or mutating plugin-generated metadata.

**Preconditions**

- [x] All Spry plugins are enabled.
- [x] `mdast-io` is configured as the I/O boundary for MDAST trees.

**Steps**

- [x] Parse this Markdown into a MDAST tree via remark + Spry plugins.
- [x] Serialize the tree with `mdast-io` to a JSON representation.
- [x] Rehydrate the JSON back into a MDAST tree.
- [x] Compare both trees structurally and semantically.

**Expected Results**

- [x] Node counts and structure are identical (modulo allowed normalization).
- [x] All `data.*` fields created by plugins are preserved.
- [x] No classification, identity, or schema metadata is lost.

###### Evidence

@id TC-RNDTRIP-0001

```yaml HFM
doc-classify:
  role: evidence
cycle: 1.0
assignee: synthetic-bot
status: passed
```

**Attachment**

- [Pre-roundtrip MDAST JSON](./evidence/TC-RNDTRIP-0001/1.0/mdast.before.json)
- [Post-roundtrip MDAST JSON](./evidence/TC-RNDTRIP-0001/1.0/mdast.after.json)
- [Diff report](./evidence/TC-RNDTRIP-0001/1.0/diff.auto.txt)

---

## Summary

@id summary-strategy

This synthetic Markdown fixture:

- Is **expressly designed** to be processed by `remark` and the **full Spry
  remark plugin stack**.
- Provides a **dense set of headings, identities, frontmatter, and code cells**
  that collectively exercise:

  - doc frontmatter plugin
  - doc schema plugin
  - heading frontmatter plugin
  - node classification plugin
  - node identities plugin
  - code annotations plugin
  - code frontmatter plugin
  - code partial plugin
  - code injection plugin
- Serves as a **long-lived, high-fidelity test resource** for `mdast-io` and any
  downstream TypeScript or Deno tooling that depends on stable, structured,
  programmable Markdown.

Any test harness that can parse this file, assert on the described behaviors,
and round-trip the tree without information loss can be considered compatible
with Spry’s **“Markdown as a programmable medium”** philosophy.
