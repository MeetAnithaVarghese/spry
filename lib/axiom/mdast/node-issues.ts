import { z } from "@zod/zod";
import { Node } from "types/mdast";
import { dataBag } from "./data-bag.ts";

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
/* Per-node helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Typed accessor for `node.data.issues`.
 *
 * Note: we *do not* auto-initialize here; `is(node)` is a pure presence check.
 */
export const nodeIssues = dataBag<"issues", NodeIssue[], Node>("issues");

/**
 * Internal helper: ensure a mutable issue array exists on the node and return it.
 */
function ensureIssuesArray(node: Node): NodeIssue[] {
  if (nodeIssues.is(node)) {
    const data = node.data as Record<string, unknown> & { issues: NodeIssue[] };
    return data.issues;
  }

  const arr: NodeIssue[] = [];
  nodeIssues.attach(node, arr);
  return arr;
}

/**
 * Append a single issue to a node.
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
  const issues = ensureIssuesArray(node);
  issues.push(issue);
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
  const arr = ensureIssuesArray(node);
  arr.push(...issues);
}

/* -------------------------------------------------------------------------- */
/* Tree-wide collectors                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Generic visitor type: given a root, call `fn(node)` for each mdast node.
 */
export type VisitFn<Root> = (root: Root, fn: (node: Node) => void) => void;

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
 */
export function collectIssuesSummary<Root>(
  root: Root,
  visitFn: VisitFn<Root>,
): IssuesSummary<IssueSeverity, NodeIssue> {
  const all: NodeIssue[] = [];
  const byNode = new Map<Node, NodeIssue[]>();
  const bySeverity = new Map<IssueSeverity, NodeIssue[]>();

  visitFn(root, (n) => {
    const node = n as Node;

    if (!nodeIssues.is(node)) return;
    const data = node.data as Record<string, unknown> & {
      issues?: NodeIssue[];
    };

    const issues = data.issues;
    if (!issues || issues.length === 0) return;

    for (const issue of issues) {
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
    }
  });

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
  let found = false;

  visitFn(root, (n) => {
    if (found) return;

    const node = n as Node;
    if (!nodeIssues.is(node)) return;

    const data = node.data as Record<string, unknown> & {
      issues?: NodeIssue[];
    };

    if (data.issues && data.issues.length > 0) {
      found = true;
    }
  });

  return found;
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
 * `nodeIssues` data bag.
 */
export function runIssueNodeRules<Root>(
  root: Root,
  visitFn: VisitFn<Root>,
  rules: readonly IssueNodeRule[],
): void {
  if (rules.length === 0) return;

  visitFn(root, (n) => {
    const node = n as Node;

    for (const rule of rules) {
      rule(node, (issue) => {
        const issues = ensureIssuesArray(node);
        issues.push(issue);
      });
    }
  });
}
