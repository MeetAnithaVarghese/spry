# Spry Node Taxonomy

Spry treats Markdown as a programmable medium. A single `.md` file produces a
physical syntax tree (mdast), which becomes a typed logical graph, which then
becomes a set of higher-level node patterns used by playbooks, pipelines, and
materialization systems.

This document describes the types of nodes Spry recognizes, where they come from
in Markdown, how the parser and graph interpreter classify them, and how to
understand the “Node Strategy Patterns” that developers will use when authoring
programmable Markdown. These patterns are opinionated guidance rather than
canonical truth; users may extend or override them.

## From Physical Markdown to Logical Nodes

Markdown begins as raw text. Spry parses it using mdast to produce a structural
representation: headings, paragraphs, fenced code blocks, lists, etc. That
physical structure is then progressively enriched:

1. The mdast tree is scanned for directives, attributes, code fences, and
   identifiable structures.
2. Each item becomes a “logical node” with a type, nature, intent, and sometimes
   a default identity.
3. Logical nodes are linked into a directed graph based on sequence, declared
   dependencies, inferred references, and other edges.
4. The runtime evaluates the graph, applying node strategy patterns to determine
   behavior: execution, storage, validation, orchestration, or simple
   documentation.

The same Markdown file therefore contains documentation, code, state, metadata,
and instructions for materialization.

## Core Categories of Nodes

Nodes fall into broad categories. Each category has multiple natures and
subtypes. These categories describe the intent of a block or directive as
interpreted by the Spry runtime.

### 1. Actionable Nodes

Actionable nodes cause something to happen. They either run executable code or
produce new artifacts.

Actionable nodes come primarily from fenced code blocks or from directives that
instruct Spry to materialize something.

Two major types:

#### 1.1 Executable Nodes

These originate from fenced code blocks whose language indicates execution. The
runtime executes the block in a sandbox and captures output, errors, and side
effects.

Typical origins:

- `bash`
- `sh`
- `deno`
- `python`
- SQL used for queries or checks (e.g., `sql` with SELECT)

Properties:

- They run and produce runtime effects.
- They may depend on previous nodes (graph edges).
- Output may be stored as captured result, used by later nodes, or written
  externally.

#### 1.2 Emittable / Materialization Nodes

These do not run but instead produce artifacts to be stored. They may be textual
or binary.

Typical origins:

- `sql` representing a migration or stored view
- `html`, `css`, `json`
- `blob` or binary container markers
- Any fenced code block designated as “storable”

Subtypes:

- Text artifacts (SQL, HTML, JSON, TS, JS, CSS, Java, etc.)
- Binary artifacts (wasm, images, zips)

Properties:

- They generate files or database entries.
- They do not execute.
- They integrate with Spry’s storable/object materialization pipeline.

### 2. Directive Nodes

Directives appear as Markdown lines whose initial token is an uppercase nature
keyword. They do not execute or produce artifacts but influence how other nodes
behave.

Origins:

- Lines matching directive syntax, e.g.,

  PARTIAL my-id TASK "Compile Sources" EXPECT view:table_exists

Directive nodes influence:

- identity and naming
- counters for auto-generated identities
- dependency graphs
- grouping and scoping
- evaluation rules (e.g., REQUIRES, EXPECT)

They are the “control plane” of programmable Markdown.

### 3. Declarative Nodes

These describe data, configuration, or state. They are not directives and not
actionable by themselves.

Typical origins:

- YAML blocks
- JSON blocks
- Parameter objects
- Structured inputs for other nodes

Declarative nodes are used as:

- inputs for execution
- configuration for materialization
- state descriptions for downstream steps

They are “data, not instructions.”

### 4. Analytic Nodes

Analytic nodes validate, lint, assess, or perform checks. They do not execute
actions or create artifacts.

Origins:

- SQL EXPLAIN or ANALYZE blocks
- Schema validations
- Linting blocks
- Test expectation blocks
- AI evaluation prompts not meant to run

Examples:

```sql
explain analyze select * from customers;
```

```json
{ "validateAgainst": "schema/customer-schema.json" }
```

Usage:

- They inspect logical or materialized state.
- They confirm data quality or behavioral correctness.
- They are essential for Spry Data Quality (Spry DQ) workflows.

### 5. Reference Nodes

These indicate external resources, imports, or dependencies outside the file.

Origins:

- fenced code blocks containing only a URL
- blocks explicitly marked as a reference
- directives such as INCLUDE path/to/file
- metadata linking external schemas, APIs, or resources

Reference nodes help build dependency graphs that cross Markdown file
boundaries. They allow Spry to understand that a node depends on something not
defined locally.

### 6. Commentary Nodes

These are ordinary Markdown content intended for human reading. They are never
actionable, never stored, never interpreted as directives. Their purpose is just
documentation.

Origins:

- paragraphs
- headings
- lists
- mermaid blocks (unless configured otherwise)

Spry keeps commentary nodes in the graph but ignores them during evaluation.

## Natures and Subtypes

Each node’s nature defines the domain of intent. Examples:

- executable
- storable
- binary
- analytic
- directive
- declarative
- reference
- commentary

Spry may infer nature from:

- code fence language
- directive token
- surrounding context
- explicit attributes

Nature affects: how the node is processed, whether it participates in graph
evaluation, and how identity is generated.

## Graph Formation and Logical Interpretation

After categorizing nodes, Spry establishes graph edges using:

- sequence: nodes follow one another unless separated by scope
- declared dependencies: REQUIRES, EXPECT, or reference lists
- inferred dependencies: use of prior results or artifacts
- materialization dependencies: created artifacts needed by later nodes

The graph then provides the evaluation plan. Some nodes cannot run until others
produce artifacts. Some nodes exist purely to annotate or validate other nodes.

Spry intentionally separates physical structure (nested Markdown) from logical
flow (dependency graph). This enables notebook-like workflows, build pipelines,
and SQL/HTML materialization processes inside Markdown.

## Node Strategy Patterns

Node strategy patterns describe recommended ways for authors to structure
Markdown to achieve predictable and maintainable behavior. They are not rigid
rules but helpful conventions.

Examples of patterns:

- Use declarative nodes to define inputs for actionable nodes that follow.
- Use directives to separate execution phases within a long document.
- Use explicit reference nodes instead of embedding URLs inside executable
  blocks.
- Use analytic nodes before actionable ones to catch failures earlier.
- Use commentary nodes between sections to maintain readability without
  affecting execution.

As Spry matures, these patterns will evolve. They serve as a shared vocabulary
between authors and the system.

---

# End-to-End Flow: From Markdown to Execution

Spry transforms a raw `.md` file through several distinct phases. Each phase
adds structure and meaning until the entire document becomes an executable,
analyzable, and materializable graph.

## 1. Raw Markdown

The author writes prose, code fences, directives, diagrams, and structured data
in plain Markdown. At this stage everything is just text.

## 2. Physical Structure (mdast)

Spry parses Markdown into an mdast tree using a standard Markdown parser.

This structure includes:

- paragraphs
- headings
- fenced code blocks
- inline code
- lists
- HTML blocks
- directive-looking lines (not yet interpreted)

At this phase, Spry knows only about syntax, not intent.

## 3. Logical Node Classification

Spry scans the mdast tree, converting nodes into typed logical nodes. This is
the moment where intent begins to emerge.

Examples:

- fenced code block labeled `bash` becomes an Executable node
- fenced block labeled `sql` might become Executable or Storable depending on
  subtype
- lines beginning with uppercase tokens become Directive nodes
- YAML or JSON blocks become Declarative nodes
- blocks referencing URLs become Reference nodes
- paragraphs remain Commentary nodes

Each node is then assigned:

- a category (actionable, directive, declarative, analytic, reference,
  commentary)
- a nature (executable, storable, binary, validation, etc.)
- a provisional identity
- attributes collected from fences or directives

Logical nodes now form the basic units Spry will reason about.

## 4. Dependency and Edge Inference

Spry derives edges between logical nodes. Edges are created by:

- explicit directives (REQUIRES, EXPECT, PROVIDES)
- sequential flow (one actionable node following another)
- name references (use of an artifact created earlier)
- declared or inferred configuration dependencies
- implicit scoping boundaries (headings, section markers, directives)

At this stage, Spry has a directed graph where nodes represent behavior and
edges represent constraints.

## 5. Graph Construction

The dependency edges and nodes are combined into a full execution graph.

The graph encodes:

- order of evaluation
- required preconditions
- materialization relationships
- cycles or invalid configurations
- analytic checks
- external references that must be resolved

The graph is the canonical internal representation used by the runtime. It is no
longer tied to the visual order of Markdown.

## 6. Strategy Pattern Application

Spry applies higher-level rules—“Node Strategy Patterns”—to refine behavior.
These patterns help interpret ambiguous or complex cases.

Examples:

- executable blocks may implicitly depend on the nearest declarative block
- storable blocks may be grouped under the nearest directive-defined scope
- analytic nodes may be run before actionable nodes
- commentary nodes may delimit conceptual sections

These patterns give Spry a consistent, opinionated interpretation without
forcing authors to learn a complicated DSL.

## 7. Evaluation and Materialization

Finally, Spry executes or materializes nodes according to:

- their category
- their nature
- the dependency graph
- runtime configuration

Typical outcomes:

- executable nodes run in a sandbox and return captured output
- storable nodes write SQL, HTML, JSON, or binary resources
- declarative nodes populate state
- analytic nodes validate or lint prior results
- reference nodes connect external inputs
- commentary nodes are ignored by the runtime

After evaluation, Spry produces:

- execution logs
- emitted files
- updated databases or views
- runtime captures for downstream steps
- a coherent reproducible pipeline defined entirely in Markdown

# Summary

Spry transforms Markdown into a mixed-medium programming environment. Nodes
originate from mdast structures, become typed logical nodes, and form a
dependency graph that drives execution, materialization, analysis, and
orchestration.

The taxonomy above provides a vocabulary for understanding how different parts
of a Markdown file behave in the Spry runtime. It bridges the gap between
physical Markdown and the higher-level workflows Spry enables.
