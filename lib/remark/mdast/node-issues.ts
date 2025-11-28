import { z } from "@zod/zod";
import { Node } from "types/mdast";
import {
  defineNodeArrayData,
  NodeWithData,
  VisitFn,
} from "../../universal/data-bag.ts";

/* -------------------------------------------------------------------------- */
/* Core issue type                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A structured issue emitted by analysis or transformation passes.
 *
 * @typeParam Severity - Issue level (e.g. `"info"`, `"warning"`, `"error"`, `"fatal"`).
 * @typeParam Baggage  - Optional extra metadata (e.g. errors, positions, rule IDs).
 *
 * The `Baggage` type allows callers to attach any structured diagnostic payload
 * without forcing a rigid shape. For example:
 *
 * ```ts
 * type RuleIssue = Issue<"error", { ruleId: string; node: Node }>;
 * ```
 */
export type Issue<Severity extends string, Baggage = unknown> = {
  /** Severity of the issue. */
  readonly severity: Severity;

  /** Human-readable error or warning message. */
  readonly message: string;

  /** the underlying error */
  readonly error?: Error | z.ZodError<unknown> | unknown;

  /** Arbitrary data-bag for extensibility */
  readonly data?: Baggage;
};

/**
 * Canonical severity set for our mdast diagnostics.
 */
export type IssueSeverity = "info" | "warning" | "error" | "fatal";

/**
 * Canonical node-issue type used throughout remark / mdast utilities.
 */
export type NodeIssue = Issue<IssueSeverity, Record<string, unknown>>;

/* -------------------------------------------------------------------------- */
/* Data-bag definition & factory                                              */
/* -------------------------------------------------------------------------- */

/**
 * Array-valued per-node "issues" bucket.
 *
 * These issues are attached on demand using the flexible data-bag model:
 *
 *   node.data.issues: NodeIssue[]
 *
 * Characteristics:
 * - **merge: true** → multiple passes can add issues incrementally
 * - Accepts any mdast `Node` as the host
 * - Stored values are strongly typed (`NodeIssue[]`)
 *
 * Example:
 * ```ts
 * import { nodeIssuesNDF } from "./node-issues.ts";
 *
 * visit(tree, "code", (node) => {
 *   nodeIssuesNDF.add(node, {
 *     severity: "warning",
 *     message: "Code block missing language",
 *   });
 * });
 * ```
 */
export const nodeIssuesDefn = defineNodeArrayData("issues" as const)<
  NodeIssue,
  Node
>({
  // Allow multiple passes to accumulate issues for the same node.
  merge: true,
});

/**
 * The underlying array-valued data factory for issues.
 *
 * Useful for:
 * - Adding issues (`add(node, issue)`)
 * - Collecting issues across a tree (`collect(root, visitFn)`)
 * - Checking whether any node has issues (`hasAny(root, visitFn)`)
 */
export const nodeIssuesNDF = nodeIssuesDefn.factory;

/**
 * Convenience type: an mdast `Node` enriched with a typed
 * `data.issues: NodeIssue[]` array.
 *
 * ```ts
 * function handle(node: WithIssuesNode) {
 *   for (const issue of node.data.issues) {
 *     console.log(issue.severity, issue.message);
 *   }
 * }
 * ```
 */
export type WithIssuesNode = NodeWithData<typeof nodeIssuesDefn>;

/* -------------------------------------------------------------------------- */
/* Per-node helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Ensure that a node has an issues array attached, returning it.
 *
 * - If `node.data.issues` already exists (and is an array), it is returned.
 * - Otherwise, an empty array is attached and returned.
 *
 * This is a safe entry point for downstream code that wants to push issues
 * without worrying about initialization.
 *
 * @example
 * ```ts
 * import { ensureIssues } from "./node-issues.ts";
 *
 * const issues = ensureIssues(node);
 * issues.push({ severity: "info", message: "Just FYI" });
 * ```
 */
export function ensureIssues(node: Node): NodeIssue[] {
  // Array factories normalize `get()` to always return an array,
  // attaching the result if `ifNotExists` is provided.
  return nodeIssuesNDF.get(node, () => []);
}

/**
 * Append a single issue to a node.
 *
 * This is a convenience wrapper over `nodeIssuesNDF.add(node, issue)`.
 *
 * @example
 * ```ts
 * addIssue(node, {
 *   severity: "error",
 *   message: "Invalid attribute",
 *   error,
 * });
 * ```
 */
export function addIssue(node: Node, issue: NodeIssue): void {
  nodeIssuesNDF.add(node, issue);
}

/**
 * Append multiple issues to a node.
 *
 * @example
 * ```ts
 * addIssues(node, [
 *   { severity: "warning", message: "Suspicious pattern" },
 *   { severity: "info", message: "Consider simplifying" },
 * ]);
 * ```
 */
export function addIssues(
  node: Node,
  issues: readonly NodeIssue[],
): void {
  if (issues.length === 0) return;
  nodeIssuesNDF.add(node, ...issues);
}

/* -------------------------------------------------------------------------- */
/* Tree-wide collectors                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Summary view of issues discovered in a tree.
 *
 * - `all`: flat list of issues (in visitation order)
 * - `byNode`: map from node → issues attached to that node
 * - `bySeverity`: map from severity → issues with that severity
 */
export interface IssuesSummary<
  S extends string = IssueSeverity,
  I extends Issue<S, unknown> = Issue<S, unknown>,
> {
  readonly all: I[];
  readonly byNode: Map<Node, I[]>;
  readonly bySeverity: Map<S, I[]>;
}

/**
 * Collect a summary of all issues from a given root using a generic `VisitFn`.
 *
 * @param root    Root value (e.g. mdast `Root`).
 * @param visitFn Generic visitor that walks nodes and calls `fn(node)`.
 *
 * @example
 * ```ts
 * import { mdastVisitFn } from "./data-bag.ts"; // your mdast adapter
 * import { collectIssuesSummary } from "./node-issues.ts";
 *
 * const summary = collectIssuesSummary(tree, mdastVisitFn);
 * console.log("Total issues:", summary.all.length);
 * console.log("Errors only:", summary.bySeverity.get("error") ?? []);
 * ```
 */
export function collectIssuesSummary<Root>(
  root: Root,
  visitFn: VisitFn<Root>,
): IssuesSummary<IssueSeverity, NodeIssue> {
  const all: NodeIssue[] = [];
  const byNode = new Map<Node, NodeIssue[]>();
  const bySeverity = new Map<IssueSeverity, NodeIssue[]>();

  nodeIssuesNDF.forEach(
    root,
    (issue, owner) => {
      const node = owner as unknown as Node;
      all.push(issue);

      // by node
      let nodeBucket = byNode.get(node);
      if (!nodeBucket) {
        nodeBucket = [];
        byNode.set(node, nodeBucket);
      }
      nodeBucket.push(issue);

      // by severity
      const severity = issue.severity;
      let sevBucket = bySeverity.get(severity);
      if (!sevBucket) {
        sevBucket = [];
        bySeverity.set(severity, sevBucket);
      }
      sevBucket.push(issue);
    },
    visitFn,
  );

  return { all, byNode, bySeverity };
}

/**
 * Simple helper: true if **any** node in the tree has at least one issue.
 *
 * @param root    Root value (e.g. mdast `Root`).
 * @param visitFn Generic visitor that walks nodes.
 */
export function hasAnyIssues<Root>(
  root: Root,
  visitFn: VisitFn<Root>,
): boolean {
  return nodeIssuesNDF.hasAny(root, visitFn);
}

/* -------------------------------------------------------------------------- */
/* Rule engine                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A node-level rule that can emit issues for a given mdast node.
 *
 * Rules are intentionally simple:
 * - They are synchronous (to keep the pipeline predictable).
 * - They receive a `report(issue)` callback to attach issues.
 *
 * @example
 * ```ts
 * const requireLangOnCode: IssueNodeRule = (node, report) => {
 *   if (node.type === "code" && !node.lang) {
 *     report({
 *       severity: "warning",
 *       message: "Code block should specify a language",
 *     });
 *   }
 * };
 * ```
 */
export type IssueNodeRule = (
  node: Node,
  report: (issue: NodeIssue) => void,
) => void;

/**
 * Run a set of node-level issue rules over a tree using a generic `VisitFn`.
 *
 * Each rule is called for every visited node and can emit any number of issues
 * via the `report()` callback. Issues are attached to nodes via the
 * `nodeIssuesNDF` factory.
 *
 * @param root    Root value (e.g. mdast `Root`).
 * @param visitFn Generic visitor that walks nodes and calls `fn(node)`.
 * @param rules   Array of node-level rules to execute.
 *
 * @example
 * ```ts
 * import { visitMdast } from "./data-bag.ts"; // your mdast adapter
 * import { runIssueNodeRules, IssueNodeRule } from "./node-issues.ts";
 *
 * const rules: IssueNodeRule[] = [
 *   (node, report) => {
 *     if (node.type === "heading" && node.depth === 1) {
 *       report({
 *         severity: "info",
 *         message: "Top-level heading seen",
 *       });
 *     }
 *   },
 * ];
 *
 * runIssueNodeRules(tree, visitMdast, rules);
 *
 * const summary = collectIssuesSummary(tree, visitMdast);
 * console.log(summary.bySeverity.get("info"));
 * ```
 */
export function runIssueNodeRules<Root>(
  root: Root,
  visitFn: VisitFn<Root>,
  rules: readonly IssueNodeRule[],
): void {
  if (rules.length === 0) return;

  visitFn(root, (n) => {
    const node = n as unknown as Node;
    for (const rule of rules) {
      rule(node, (issue) => {
        nodeIssuesNDF.add(node, issue);
      });
    }
  });
}
