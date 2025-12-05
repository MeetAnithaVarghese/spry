import { docFrontmatterDataBag } from "../../remark/doc-frontmatter.ts";
import { GraphEdge } from "../orchestrate.ts";
import {
  augmentRule,
  GraphEdgesRule,
  isIterable,
  RuleContext,
} from "./governance.ts";
import { selectedNodesClassificationRule } from "./selected-nodes-classification.ts";

/**
 * frontmatterClassificationRule
 *
 * Reads a frontmatter record (e.g. parsed YAML) and a key such as "doc-classify",
 * expecting an array of entries:
 *
 *   doc-classify:
 *     - select: heading[depth="1"]
 *       role: project
 *     - select: heading[depth="2"]
 *       role: strategy
 *     - select: heading[depth="3"]
 *       role: plan
 *     - select: heading[depth="4"]
 *       role: suite
 *     - select: heading[depth="5"]
 *       role: case
 *     - select: heading[depth="6"]
 *       role: evidence
 *
 * For each entry:
 *   - `select` is a unist-util-select selector
 *   - every other key/value pair (e.g., role: project) generates a relationship:
 *       rel = `${key}:${value}`
 *   - It wraps `selectedNodesClassificationRule` to emit:
 *       root --rel--> node
 *     for each node matched by `select`.
 */
export function frontmatterClassificationRule<
  Relationship extends string,
  Ctx extends RuleContext,
  Edge extends GraphEdge<Relationship>,
>(
  frontmatterKey: string,
  frontmatter?: Record<string, unknown> | null | undefined,
): GraphEdgesRule<Relationship, Ctx, Edge> {
  return augmentRule<Relationship, Ctx, Edge>((ctx) => {
    if (!frontmatter && docFrontmatterDataBag.is(ctx.root)) {
      frontmatter = ctx.root.data.documentFrontmatter.parsed.fm;
    }
    if (!frontmatter) return false;

    const raw = frontmatter[frontmatterKey];
    if (!Array.isArray(raw)) return false;

    const allEdges: Edge[] = [];

    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;

      const rec = entry as Record<string, unknown>;
      const selectorValue = rec["select"];
      if (typeof selectorValue !== "string") continue;
      const selector = selectorValue.trim();
      if (!selector) continue;

      // For each non-`select` key, generate a relationship `${key}:${value}`
      for (const [k, v] of Object.entries(rec)) {
        if (k === "select") continue;
        if (
          typeof v !== "string" &&
          typeof v !== "number" &&
          typeof v !== "boolean"
        ) {
          continue;
        }

        const rel = `${k}:${String(v)}` as Relationship;

        // Wrap selectedNodesClassificationRule and run it immediately
        const rule = selectedNodesClassificationRule<Relationship, Ctx, Edge>(
          selector,
          rel,
        );

        const result = rule(ctx, []);
        if (result && isIterable<Edge>(result)) {
          for (const e of result) {
            allEdges.push(e);
          }
        }
      }
    }

    return allEdges.length ? allEdges : false;
  });
}
