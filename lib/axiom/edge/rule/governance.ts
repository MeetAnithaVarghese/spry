import { Root } from "types/mdast";
import { GraphEdge } from "../orchestrate.ts";

export type RuleContext = {
  readonly root: Root;
};

/**
 * Rule:
 *  - Receives the current context and the incoming edge stream.
 *  - Returns the outgoing edges or `false` to drop everything.
 */
export type GraphEdgesRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
> = (ctx: Ctx, incoming: Iterable<Edge>) => Iterable<Edge> | false;

// -----------------------------------------------------------------------------
// Helper: iterable detection
// -----------------------------------------------------------------------------

export function isIterable<T>(value: unknown): value is Iterable<T> {
  if (value == null) return false;
  return typeof (value as Iterable<unknown>)[Symbol.iterator] === "function";
}

// -----------------------------------------------------------------------------
// Rule Builders
// -----------------------------------------------------------------------------

/** Pass-through + append edges produced by builder */
export function augmentRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  build: (ctx: Ctx) => Iterable<Edge> | false,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return (ctx, incoming) => {
    const built = build(ctx);
    if (built === false) return incoming;

    const add: Iterable<Edge> = built;

    function* output(): Iterable<Edge> {
      for (const e of incoming) yield e;
      for (const e of add) yield e;
    }
    return output();
  };
}

/** A rule that emits only its own edges, ignoring incoming ones */
export function sourceRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  build: (ctx: Ctx) => Iterable<Edge> | false,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return (ctx, _incoming) => build(ctx);
}

/** Transform incoming edges (rewrite, expand, or drop) */
export function transformRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  transform: (
    ctx: Ctx,
    edge: Edge,
  ) => Edge | Iterable<Edge> | null | false,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return function* (ctx, incoming): Iterable<Edge> {
    for (const e of incoming) {
      const out = transform(ctx, e);
      if (!out) continue;
      if (isIterable<Edge>(out)) {
        for (const e2 of out) yield e2;
      } else {
        yield out;
      }
    }
  };
}

/** Filter edges via predicate */
export function filterEdgesRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  predicate: (ctx: Ctx, edge: Edge) => boolean,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return transformRule((ctx, edge) => predicate(ctx, edge) ? edge : null);
}

/** Deduplicate edges using a key function */
export function dedupeEdgesRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  keyFn: (edge: Edge) => string,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return function* (_ctx, incoming): Iterable<Edge> {
    const seen = new Set<string>();
    for (const e of incoming) {
      const key = keyFn(e);
      if (seen.has(key)) continue;
      seen.add(key);
      yield e;
    }
  };
}

/** Tap rule for debugging or "watching" and acting on existing stream */
export function tapRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  fn: (ctx: Ctx, edge: Edge) => void,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return function* (ctx, incoming): Iterable<Edge> {
    for (const e of incoming) {
      fn(ctx, e);
      yield e;
    }
  };
}

/** Final rule receiving all edges and returning a new stream */
export function finalizeRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  fn: (ctx: Ctx, edges: Iterable<Edge>) => Iterable<Edge>,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return (ctx, incoming) => fn(ctx, incoming);
}

// -----------------------------------------------------------------------------
// GraphRulesBuilder (fluent API)
// -----------------------------------------------------------------------------

export interface GraphRulesBuilder<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
> {
  /** Use a pre-built rule directly */
  use(
    rule: GraphEdgesRule<Relationship, Ctx, Edge>,
  ): this;

  /** Add a source rule (ignores incoming edges) */
  source(
    build: (ctx: Ctx) => Iterable<Edge> | false,
  ): this;

  /** Add an augment rule (passes through + adds edges) */
  augment(
    build: (ctx: Ctx) => Iterable<Edge> | false,
  ): this;

  /** Add a transform rule */
  transform(
    transformFn: (
      ctx: Ctx,
      edge: Edge,
    ) => Edge | Iterable<Edge> | null | false,
  ): this;

  /** Add a filter rule */
  filter(
    predicate: (ctx: Ctx, edge: Edge) => boolean,
  ): this;

  /** Add a dedupe rule */
  dedupe(
    keyFn: (edge: Edge) => string,
  ): this;

  /** Add a tap rule (for logging/debugging) */
  tap(
    fn: (ctx: Ctx, edge: Edge) => void,
  ): this;

  /** Add a finalize rule */
  finalize(
    fn: (ctx: Ctx, edges: Iterable<Edge>) => Iterable<Edge>,
  ): this;

  /** Build the rules array compatible with astGraphEdges */
  build(): GraphEdgesRule<Relationship, Ctx, Edge>[];
}

export function createGraphRulesBuilder<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(): GraphRulesBuilder<Relationship, Ctx, Edge> {
  const rules: GraphEdgesRule<Relationship, Ctx, Edge>[] = [];

  const api: GraphRulesBuilder<Relationship, Ctx, Edge> = {
    use(rule) {
      rules.push(rule);
      return this;
    },

    source(build) {
      rules.push(sourceRule<Relationship, Ctx, Edge>(build));
      return this;
    },

    augment(build) {
      rules.push(augmentRule<Relationship, Ctx, Edge>(build));
      return this;
    },

    transform(transformFn) {
      rules.push(transformRule<Relationship, Ctx, Edge>(transformFn));
      return this;
    },

    filter(predicate) {
      rules.push(filterEdgesRule<Relationship, Ctx, Edge>(predicate));
      return this;
    },

    dedupe(keyFn) {
      rules.push(dedupeEdgesRule<Relationship, Ctx, Edge>(keyFn));
      return this;
    },

    tap(fn) {
      rules.push(tapRule<Relationship, Ctx, Edge>(fn));
      return this;
    },

    finalize(fn) {
      rules.push(finalizeRule<Relationship, Ctx, Edge>(fn));
      return this;
    },

    build() {
      return [...rules];
    },
  };

  return api;
}

// -----------------------------------------------------------------------------
// Typed Relationships Helper
// -----------------------------------------------------------------------------

/**
 * Define a fixed set of relationship literals in a type-safe way.
 *
 * Example:
 *   const rels = defineRelationships("containedInHeading", "isTask", "isImportant");
 *   type Relationship = (typeof rels)[number];
 */
export function defineRelationships<const R extends readonly string[]>(
  ...relationships: R
): R {
  return relationships;
}
