// lib/axiom/mdast/node-issues_test.ts
import {
  assert,
  assertEquals,
  assertFalse,
  assertStrictEquals,
} from "@std/assert";

import type { Code, Heading, Node } from "types/mdast";
import {
  addIssue,
  addIssues,
  collectIssuesSummary,
  hasAnyIssues,
  type IssueNodeRule,
  type NodeIssue,
  nodeIssues,
  runIssueNodeRules,
  type VisitFn,
} from "./node-issues.ts";

Deno.test("node-issues utilities", async (t) => {
  // Minimal test tree shape: mdast-like nodes with optional children.
  type TestNode = Node & {
    children?: TestNode[];
  };

  type TestRoot = TestNode;

  const visit: VisitFn<TestRoot> = (root, fn) => {
    const walk = (n: TestNode) => {
      fn(n);
      if (n.children) {
        for (const child of n.children) walk(child);
      }
    };
    walk(root);
  };

  await t.step(
    "nodeIssues + addIssue/addIssues attach issues to node.data",
    () => {
      const node = { type: "paragraph" } as TestNode;

      // Initially, no issues bag
      assertFalse(nodeIssues.is(node));

      const issue1: NodeIssue = {
        severity: "warning",
        message: "First warning",
        data: { code: "W1" },
      };

      addIssue(node, issue1);

      // Now the bag should exist
      assert(nodeIssues.is(node));
      const afterFirst = node.data as Record<string, unknown> & {
        issues: NodeIssue[];
      };

      assertEquals(afterFirst.issues.length, 1);
      assertStrictEquals(afterFirst.issues[0], issue1);

      const issue2: NodeIssue = {
        severity: "error",
        message: "Something broke",
      };
      const issue3: NodeIssue = {
        severity: "info",
        message: "FYI only",
      };

      addIssues(node, [issue2, issue3]);

      const afterAll = node.data as Record<string, unknown> & {
        issues: NodeIssue[];
      };
      assertEquals(afterAll.issues.length, 3);
      assertStrictEquals(afterAll.issues[0], issue1);
      assertStrictEquals(afterAll.issues[1], issue2);
      assertStrictEquals(afterAll.issues[2], issue3);
    },
  );

  await t.step(
    "collectIssuesSummary and hasAnyIssues aggregate issues across tree",
    () => {
      const leaf1 = { type: "paragraph" } as TestNode;
      const leaf2 = { type: "code" } as TestNode;
      const root: TestRoot = {
        type: "root",
        children: [leaf1, leaf2],
      } as TestRoot;

      addIssue(leaf1, {
        severity: "warning",
        message: "Suspicious pattern",
      });

      addIssues(leaf2, [
        { severity: "error", message: "Invalid syntax" },
        { severity: "info", message: "Consider refactoring" },
      ]);

      const summary = collectIssuesSummary(root, visit);

      // all
      assertEquals(summary.all.length, 3);

      // byNode
      assertEquals(summary.byNode.size, 2);
      assertEquals(summary.byNode.get(leaf1)?.length ?? 0, 1);
      assertEquals(summary.byNode.get(leaf2)?.length ?? 0, 2);

      // bySeverity
      assertEquals(summary.bySeverity.get("warning")?.length ?? 0, 1);
      assertEquals(summary.bySeverity.get("error")?.length ?? 0, 1);
      assertEquals(summary.bySeverity.get("info")?.length ?? 0, 1);

      // hasAnyIssues: true for this tree
      assertEquals(hasAnyIssues(root, visit), true);

      // Another tree with no issues
      const cleanRoot: TestRoot = {
        type: "root",
        children: [
          { type: "paragraph" } as TestNode,
          { type: "heading" } as TestNode,
        ],
      } as TestRoot;

      assertEquals(hasAnyIssues(cleanRoot, visit), false);
    },
  );

  await t.step("runIssueNodeRules executes rules and attaches issues", () => {
    const heading1 = { type: "heading", depth: 1 } as unknown as TestNode;
    const heading2 = { type: "heading", depth: 2 } as unknown as TestNode;
    const code1 = { type: "code", lang: undefined } as unknown as TestNode;
    const para = { type: "paragraph" } as unknown as TestNode;

    const root: TestRoot = {
      type: "root",
      children: [heading1, heading2, code1, para],
    } as TestRoot;

    const rules: IssueNodeRule[] = [
      // Report info on any heading
      (node, report) => {
        if (node.type === "heading") {
          const heading = node as Heading;
          report({
            severity: "info",
            message: "Heading depth seen",
            data: { depth: heading.depth },
          });
        }
      },
      // Report warning on code blocks without language
      (node, report) => {
        if (node.type === "code") {
          const codeNode = node as Code;
          if (codeNode.lang == null) {
            report({
              severity: "warning",
              message: "Code block should specify a language",
            });
          }
        }
      },
    ];

    runIssueNodeRules(root, visit, rules);

    const summary = collectIssuesSummary(root, visit);

    // 2 headings -> 2 info issues, 1 code without lang -> 1 warning
    assertEquals(summary.all.length, 3);

    const infoIssues = summary.bySeverity.get("info") ?? [];
    const warnIssues = summary.bySeverity.get("warning") ?? [];

    assertEquals(infoIssues.length, 2);
    assertEquals(warnIssues.length, 1);

    // Ensure per-node attachment is correct
    const byNode = summary.byNode;
    assertEquals(byNode.get(heading1)?.length ?? 0, 1);
    assertEquals(byNode.get(heading2)?.length ?? 0, 1);
    assertEquals(byNode.get(code1)?.length ?? 0, 1);
    assertEquals(byNode.get(para)?.length ?? 0, 0);
  });
});
