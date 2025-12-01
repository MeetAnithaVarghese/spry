# Axiom Rule-Driven Graph Engine for `unist` and `mdast`

Axiom is the Spry Programmable Markdown library's lightweight, deterministic
graph-building and projections engine for the `unist` `mdast` ecosystem. It
provides a remark-like pipeline for defining _rules_ that produce _edges_
connecting any `unist`-like `mdast` nodes by named relationships.

Axiom turns Markdown (and arbitrary `unist` trees) into semantic graphs called
_graph projections_ or just _projections_ that can be:

- traversed as hierarchical trees
- queried as general graph structures
- consumed by tools, text-UIs, web-UIs, pipelines, runbooks, documentation
  systems, and AI agents via JSON
- used as the semantic substrate underlying the _Spry Programmatic Markdown
  ecosystem_ ([https://sprymd.org](https://sprymd.org))

Axiom enables Markdown to behave like a structured, executable, analyzable, and
queryable knowledge system instead of just text.

## Try it out

Explorer Text-UI (`CLI`)

```bash cli
./lib/axiom/text-ui/cli.ts ls lib/axiom/fixture/pmd/comprehensive.md
```

Web-UI

```bash web-ui
./lib/axiom/web-ui/service.ts web-ui lib/axiom/fixture/pmd/comprehensive.md
```

Runbook Text-UI (`runbook.ts`)

```bash cli
# spry.ts imports from lib/axiom/text-ui/runbook.ts
cd support/assurance/runbook
./spry.ts ls fixture-01.md
./spry.ts run fixture-01.md

./spry.ts run fixture-01.md --graph special
./spry.ts task clean fixture-01.md
```

## Why Axiom?

Modern Markdown-based workflows (docs, runbooks, knowledge systems, engineering
handbooks, technical standards, compliance systems, etc.) require structure,
relationships, and meaning, not just syntax trees.

Axiom is built for:

- Programmable Documentation which automatically derive relationships between
  sections, headings, code blocks, decorators, directives, tasks, steps, or
  roles.

- Runbook Automation which can extract operational steps, dependencies,
  preconditions, and task semantics from Markdown and feed them into execution
  engines.

- Engineering Knowledge Graphs that can build navigable, queryable graph models
  from Markdown, YAML, TOML, code blocks, or mixed unist trees.

- AI-Enhanced Technical Systems can feed clean, explicit graph relationships
  into LLMs as structured context rather than raw text.

## How Spry Processing Works

### unist → the universal syntax tree

- What it is: A generic tree model for representing any structured text.
- Why Spry uses it: All higher-level trees (Markdown, HTML, MDX, custom nodes)
  share the same basic shape.
- Where to look: Core node types, `Node`, `Parent`, and traversal helpers.

→ unist gives Spry the _base data structure_ for everything.

### mdast → unist specialized for Markdown

- What it is: A concrete schema on top of unist for headings, paragraphs, code
  fences, lists, etc.
- Why Spry uses it: Spry workflows live inside Markdown files, so mdast is the
  structural grammar.
- Where to look: `Heading`, `Paragraph`, `Code`, and other mdast node
  definitions.

→ mdast gives Spry a _Markdown-aware_ syntax tree.

### remark → the Markdown parser/processor

- What it is: Pipeline engine that takes raw `.md` text and produces mdast.
- Why Spry uses it: Spry relies on remark’s mature ecosystem to parse, extend,
  and decorate Markdown.
- Where to look: remark plugins used by Spry (frontmatter, directives, code
  imports, decorators, provenance, etc.).

→ remark transforms Markdown text → mdast trees ready for enrichment.

### axiom → mdast → graph pipeline

- What it is: Spry’s structural analysis layer. It walks mdast and produces a
  _graph of semantic edges_.
- Why Spry uses it: Markdown documents aren’t linear lists; they form logical
  structures (sections, flows, relationships). Axiom extracts these
  relationships.
- Where to look:

  - Edge rules
  - Edge pipeline
  - Graph tree builders
  - Semantic decorators and node enrichment

→ axiom turns mdast into a _graph_ that captures meaning, not just structure.

### axiom projections → converting graphs into Spry “business” pipelines

- What they are: Projection modules that reshape the axiom graph into
  domain-specific models.
- Why Spry uses them: Different use cases (runbooks, data-quality checks, SQL
  orchestration, notebook execution) need different views of the same underlying
  doc.
- Where to look: GraphProjection/GraphProjectionDocument types and projection
  helpers.

→ projections turn the generic graph into _task-specific structures_.

### Spry runbooks, data-quality pipelines, SQL libraries

- What they are: Final _pattern_, _service_ or _application_ layers that operate
  on projection outputs.

- Examples:

  - Runbooks → ordered executable steps derived from headings + semantic
    decorators
  - Data Quality (Spry DQ) → validation edges, expectations, provenance
  - SQL pipelines → SQL cells + code fences converted into executable or emitted
    SQL
  - Notebook notebooks → execution graphs for fenced code, producing artifacts

- Where to look: Each feature has:

  - A projection module
  - A runtime module
  - A CLI entry (usually under `cli.ts` or `service.ts`)

→ these are the _end-user features_ built entirely on top of projections.

### Putting It All Together (Mental Model)

```
Raw Markdown (.md)
       ↓
  remark (parsing)
        ↓
    mdast (Markdown AST, using unist underneath)
          ↓
      Axiom (semantics → graph + relationships)
            ↓
        Axiom projections (flexible operating views of graphs and relationships)
              ↓
          Spry pipelines (business-specific runbooks, DQ, SQL, notebooks, etc.)
```

- If you want to understand the raw Markdown structure, read mdast types.
- If you want to understand how Markdown becomes a graph, look at axiom edge
  rules.
- If you want to understand the shapes used by Spry features, check the axiom
  projection modules.
- If you want to understand how runbooks / DQ / SQL behave, read the final
  pipeline modules which consume projections.
- If something “looks like a remark plugin,” it’s probably in the pipeline
  before axiom.
- If something “looks like relationships or graph rules,” it’s in axiom.
- If something “looks like a business workflow,” it’s in projections or final
  Spry pipelines.

### Nodes (unist / mdast)

Axiom works on any unist-compatible syntax tree:

- Markdown headings
- Paragraphs
- Lists, list items, tables
- Code blocks
- Directives or custom nodes (`decorator`, `frontmatter`, etc.)
- YAML/TOML/JSON children
- Arbitrary unist extensions

Every node is uniquely identified and included in the final graph.

### Axiom Rules

Axiom provides a remark-like plugin API where each rule examines nodes and emits
ModelGraphEdge entries:

```ts
{
  rel: "containedInSection",
  from: Node,
  to: Node,
  meta?: {...}
}
```

Common rule patterns:

- Structural relationships `containedInSection`, `parentHeading`,
  `siblingHeading`, `taskOf`, etc.

- Semantic decorators (`@id`, `@case`, `@role`, `@suite`, `@strategy`) can bind
  to the nearest parent heading or section.

- Frontmatter relationships Linking YAML/TOML frontmatter to the root.

- Dependency edges Code block dependencies, references, imports, or resource
  use.

Rules run in a deterministic pipeline, similar to how remark plugins operate,
but produce _semantic edges_ instead of textual mutations.

Axiom rules might produce edges:

- `semanticDecorator → heading`
- `heading → codeBlock`
- `containedInSection` hierarchy edges
- `isTask` or `isStep` depending on your rule definitions

These edges become a task graph consumable by:

- Spry runbook engines
- visualization components
- AI agents
- quality / compliance checks
- or any other kind of projection consumer

### Axiom Rules Features Summary

- Full `unist` + `mdast` compatibility
- Deterministic rule engine
- Named edges expressing semantic relationships
- Graph + hierarchy models
- Multi-document support
- Supports custom decorators & custom node types
- Works directly inside Spry pipelines
- Ideal for runbooks, standards, engineering docs, and AI-ready knowledge
  systems
- Easily extensible

### Example Rule (pseudo-code)

```ts
export function semanticDecoratorRule(node, ctx) {
  if (node.type !== "decorator") return [];
  const nearestHeading = findNearestHeading(node, ctx.root);

  return [{
    rel: "sectionSemanticId",
    from: node,
    to: nearestHeading,
  }];
}
```

## Axiom Edges

Low-level graph edges are stored as objects in memory for internal consumption
and are not serialization friendly but higher-level projection edges are stored
as strings to serialize them as JSON or text and process them in multiple
clients:

```ts
type FlexibleProjectionEdge = {
  id: string;
  documentId: string;
  from: string;
  to: string;
  rel: string;
};
```

Axiom flexible projections accumulate edges across:

- entire Markdown documents
- multi-file collections
- synthetic nodes injected during processing
- custom ASTs created by pipelines

Edges describe a semantic graph over your Markdown/unist trees.

## Graph + Tree Projections

After rules execute, Axiom compiles the edges into:

### `FlexibleProjection`

A relational view where all nodes and edges can be queried arbitrarily.

Used for:

- analytics
- model inspection
- automated validation
- AI embeddings / RAG-free modeling
- compliance / governance pipelines

### `GraphTree`

A hierarchy computed from structural relationships (like `containedInSection`).

Used for:

- navigation
- rendering
- “Spry Content” section extraction
- generating tables of contents
- runbook step flows

## How Axiom Fits into SpryMD ([https://sprymd.org](https://sprymd.org))

SpryMD defines a modern vision for Programmable Markdown, emphasizing:

- content that is both human-readable and machine-executable
- deterministic pipelines
- rule-based transformations
- graph-centric representations of documents
- semantic decorators to encode meaning
- extraction of runbooks, diagrams, specs, and structured data from Markdown

Axiom is the semantic engine behind that vision.

## Roadmap

Future planned enhancements:

- Relationship categories (task, structural, semantic, role, strategy…)
- Rule debugging + visualization
- Graph queries (XPath-like or GraphQL-like)
- Integration with Spry notebooks / code cells
- Language-server integration for semantic navigation
- AI-assisted rule authoring
- Rule-based cross-file dependency tracking

## Who Should Use Axiom?

Axiom is ideal for:

- teams building runbooks, SOPs, playbooks, postmortems
- documentation-driven engineering orgs
- compliance / audit workflows
- open-source documentation systems
- DevOps & SRE groups capturing operations in Markdown
- AI-powered assistants needing structured context

## License & Status

Axiom is currently an internal module of the Spry Ecosystem. Public packaging
and documentation to follow.
