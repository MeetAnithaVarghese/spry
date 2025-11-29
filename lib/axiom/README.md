# Axiom — A Rule-Driven Graph Engine for `unist` and `mdast`

Axiom is the Spry Programmable Markdown library's lightweight, deterministic
graph-building engine for the `unist` `mdast` ecosystem. It provides a
remark-like pipeline for defining _rules_ that produce _edges_ connecting any
`unist`-like `mdast` nodes by named relationships.

Axiom turns Markdown (and arbitrary `unist` trees) into semantic graphs that can
be:

- traversed as hierarchical trees
- queried as general graph structures
- consumed by tools, pipelines, runbooks, documentation systems, and AI agents
- used as the semantic substrate underlying the _Spry Programmatic Markdown
  ecosystem_ ([https://sprymd.org](https://sprymd.org))

Axiom enables Markdown to behave like a structured, executable, analyzable, and
queryable knowledge system instead of just text.

## Try it out

**Text-UI** (`CLI`)

```bash cli
./lib/axiom/text-ui/cli.ts ls lib/axiom/fixture/pmd/comprehensive.md
```

**Web-UI**

```bash web-ui
./lib/axiom/web-ui/service.ts web-ui lib/axiom/fixture/pmd/comprehensive.md
```

## Why Axiom?

Modern Markdown-based workflows (docs, runbooks, knowledge systems, engineering
handbooks, technical standards, compliance systems, etc.) require structure,
relationships, and meaning, not just syntax trees.

Axiom is built for:

- Programmable Documentation Automatically derive relationships between
  sections, headings, code blocks, decorators, directives, tasks, steps, or
  roles.

- Runbook Automation Extract operational steps, dependencies, preconditions, and
  task semantics from Markdown and feed them into execution engines.

- Engineering Knowledge Graphs Build navigable, queryable graph models from
  Markdown, YAML, TOML, code blocks, or mixed unist trees.

- SpryMD Semantic Layers Provide the semantic substrate behind Spry content
  rendering, decorator parsing, transformations, and programmatic notebooks.

- AI-Enhanced Technical Systems Feed clean, explicit graph relationships into
  LLMs as structured context rather than raw text.

# Core Concepts

## 1. Nodes (unist / mdast)

Axiom works on any unist-compatible syntax tree:

- Markdown headings
- Paragraphs
- Lists, list items, tables
- Code blocks
- Directives or custom nodes (`decorator`, `frontmatter`, etc.)
- YAML/TOML/JSON children
- Arbitrary unist extensions

Every node is uniquely identified and included in the final graph.

## 2. Rules

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

## 3. Edges

Edges are stored as:

```ts
type GraphViewerEdge = {
  id: string;
  documentId: string;
  from: string;
  to: string;
  rel: string;
};
```

Axiom accumulates edges across:

- entire Markdown documents
- multi-file collections
- synthetic nodes injected during processing
- custom ASTs created by pipelines

Edges describe a semantic graph over your Markdown/unist trees.

## 4. Graph + Tree Models

After rules execute, Axiom compiles the edges into:

### Graph Model

A relational view where all nodes and edges can be queried arbitrarily.

Used for:

- analytics
- model inspection
- automated validation
- AI embeddings / RAG-free modeling
- compliance / governance pipelines

### Tree Model

A hierarchy computed from structural relationships (like `containedInSection`).

Used for:

- navigation
- rendering
- “Spry Content” section extraction
- generating tables of contents
- runbook step flows

# How Axiom Fits into SpryMD ([https://sprymd.org](https://sprymd.org))

SpryMD defines a modern vision for Programmable Markdown, emphasizing:

- content that is both human-readable and machine-executable
- deterministic pipelines
- rule-based transformations
- graph-centric representations of documents
- semantic decorators to encode meaning
- extraction of runbooks, diagrams, specs, and structured data from Markdown

Axiom is the semantic engine behind that vision.

Specifically, Axiom enables:

### ✔ Spry Semantic Decorators

(`@id`, `@case`, `@role`, `@plan`, etc.) Bind decorators to their nearest
semantic parent section, heading, or node, forming a graph of meaning.

### ✔ Spry Content Rendering

Extract the correct Markdown section based on the graph, not just text offsets.

### ✔ Runbook Derivation

Turn Markdown into structured task graphs for scheduled or automated execution.

### ✔ Generated Documentation

Use graph relationships to produce:

- API reference mappings
- test plans
- compliance chains
- SOPs
- architectural or lineage diagrams

### ✔ AI-Enhanced Workflows

Provide structured models to language models, avoiding reliance on RAG against
unstructured text.

# Example: Axiom Rules in Action

Given Markdown:

````md
@id step-001

### Install dependencies

Run:

```bash
npm install
```
````

````
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

# Example Rule (pseudo-code)

```ts
export function semanticDecoratorRule(node, ctx) {
  if (node.type !== "decorator") return [];
  const nearestHeading = findNearestHeading(node, ctx.root);
  
  return [{
    rel: "sectionSemanticId",
    from: node,
    to: nearestHeading
  }];
}
````

Rules remain simple, composable, and predictable.

# Features Summary

- ✔ Full `unist` + `mdast` compatibility
- ✔ Deterministic rule engine
- ✔ Named edges expressing semantic relationships
- ✔ Graph + hierarchy models
- ✔ Multi-document support
- ✔ Supports custom decorators & custom node types
- ✔ Works directly inside Spry pipelines
- ✔ Ideal for runbooks, standards, engineering docs, and AI-ready knowledge
  systems
- ✔ Easily extensible

# Roadmap

Future planned enhancements:

- Relationship categories (task, structural, semantic, role, strategy…)
- Rule debugging + visualization
- Graph queries (XPath-like or GraphQL-like)
- Integration with Spry notebooks / code cells
- Language-server integration for semantic navigation
- AI-assisted rule authoring
- Rule-based cross-file dependency tracking

# Who Should Use Axiom?

Axiom is ideal for:

- teams building runbooks, SOPs, playbooks, postmortems
- documentation-driven engineering orgs
- compliance / audit workflows
- open-source documentation systems
- DevOps & SRE groups capturing operations in Markdown
- AI-powered assistants needing structured context

# License & Status

Axiom is currently an internal module of the Spry Ecosystem. Public packaging
and documentation to follow.
