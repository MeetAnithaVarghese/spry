import { Root } from "types/mdast";
import { Node } from "types/unist";
import { GraphEdgesRule, RuleContext } from "./rule/mod.ts";

export type GraphEdge<Relationship extends string> = {
  readonly rel: Relationship;
  readonly from: Node;
  readonly to: Node;
};

// -----------------------------------------------------------------------------
// Pipeline Engine
// -----------------------------------------------------------------------------

/**
 * Run the rules as a pipeline:
 *
 *   root → rule1 → rule2 → rule3 → ... → final edges
 */
export function* astGraphEdges<
  Relationship extends string,
  Edge extends GraphEdge<Relationship>,
  Ctx extends RuleContext,
>(
  root: Root,
  init: {
    readonly prepareContext: (root: Root) => Ctx;
    readonly rules: (
      ctx: Ctx,
    ) =>
      | Iterable<
        GraphEdgesRule<Relationship, Ctx, Edge>
      >
      | Generator<
        GraphEdgesRule<Relationship, Ctx, Edge>
      >;
  },
) {
  const { prepareContext, rules: rulesFn } = init;

  const ctx = prepareContext(root);
  const rules = rulesFn(ctx);

  let current: Iterable<Edge> = [];

  for (const rule of rules) {
    const produced = rule(ctx, current);

    if (produced === false) {
      current = [];
      continue;
    }

    current = produced;
  }

  for (const e of current) {
    yield e;
  }
}
