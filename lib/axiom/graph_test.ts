// graph_test.ts
import { assert, assertEquals } from "@std/assert";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { Heading, Root, RootContent, Text } from "types/mdast";
import type { Node } from "types/unist";
import { astGraphEdges, GraphEdge } from "./edge/mod.ts";
import {
  containedInHeadingRule,
  containedInSectionRule,
  createGraphRulesBuilder,
  defineRelationships,
  frontmatterClassificationRule,
  IsSectionContainer,
  nodeDependencyRule,
  nodesClassificationRule,
  RuleContext,
  sectionFrontmatterRule,
  selectedNodesClassificationRule,
} from "./edge/rule/mod.ts";

const relationships = defineRelationships(
  "containedInHeading",
  "containedInSection",
  "isImportant",
  "isTask",
  "isSelected",
  "codeDependsOn",
  "frontmatter",
);
type Relationship = (typeof relationships)[number];

type TestEdge = GraphEdge<Relationship>;
type TestCtx = RuleContext;

// Synthetic markdown with nested headings, lists, emphasis, etc.
const syntheticMarkdown = `
# Heading 1

Intro paragraph.

## Subheading 1.1

- item 1
- item 2 *important*

### Sub-subheading 1.1.1

Paragraph under sub-subheading.

## Subheading 1.2

Another paragraph.

# Heading 2

- item A
- item B
`;

// Synthetic markdown with heading-like paragraphs
const headingLikeMarkdown = `
**Alpha section**:

First paragraph in Alpha.

**Bravo section:**

First paragraph in Bravo.

Charlie section:

- item 1
- item 2
`;

// Synthetic markdown mixing real headings and heading-like paragraphs
const mixedSectionMarkdown = `
# Real Heading 1

**Alpha section**:

Content A under Alpha.

# Real Heading 2

Bravo section:

Content B under Bravo.
`;

// Helper: parse markdown to mdast Root
function parseMarkdown(md: string): Root {
  const tree = unified().use(remarkParse).parse(md) as Root;
  return tree;
}

// Helper: extract heading text for assertions
function headingText(node: Node): string {
  const heading = node as Heading;
  if (heading.type !== "heading") return "";
  const parts: string[] = [];
  for (const child of heading.children ?? []) {
    const textNode = child as Text;
    if (textNode.type === "text" && typeof textNode.value === "string") {
      parts.push(textNode.value);
    }
  }
  return parts.join("");
}

// Helper: collect all heading nodes in document order
function collectHeadings(root: Root): Heading[] {
  const headings: Heading[] = [];
  const visitNode = (node: RootContent | Root): void => {
    if (node.type === "heading") {
      headings.push(node as Heading);
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children as RootContent[]) {
        visitNode(child);
      }
    }
  };
  visitNode(root);
  return headings;
}

// Helper: flatten visible text from a node (ignores formatting)
function nodePlainText(node: Node): string {
  const parts: string[] = [];

  function walk(n: Node) {
    if (
      (n as { value?: unknown }).value &&
      (n as { type?: string }).type === "text"
    ) {
      // deno-lint-ignore no-explicit-any
      parts.push(String((n as any).value));
    }
    const anyN = n as { children?: Node[] };
    if (Array.isArray(anyN.children)) {
      for (const c of anyN.children) walk(c);
    }
  }

  walk(node);
  return parts.join("");
}

// isSectionContainer that only treats real headings as containers
const headingOnlySectionContainer: IsSectionContainer = (node) => {
  if (node.type === "heading") {
    return {
      nature: "heading",
      label: headingText(node),
      mdLabel: headingText(node),
    };
  }
  return false;
};

// isSectionContainer that treats headings AND heading-like paragraphs as containers
const headingLikeSectionContainer: IsSectionContainer = (node) => {
  if (node.type === "heading") {
    return {
      nature: "heading",
      label: headingText(node),
      mdLabel: headingText(node),
    };
  }

  if (node.type === "paragraph") {
    const plain = nodePlainText(node).trim();
    if (plain.endsWith(":")) {
      const label = plain.slice(0, -1).trim();
      if (label.length > 0) {
        return {
          nature: "section",
          label,
          mdLabel: plain,
        };
      }
    }
  }

  return false;
};

Deno.test("graph domain rules on synthetic markdown", async (t) => {
  const root = parseMarkdown(syntheticMarkdown);

  const baseCtx: TestCtx = { root };

  await t.step("containedInHeadingRule - basic invariants", () => {
    const edges = [
      ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
        prepareContext: () => baseCtx,
        rules: () => [
          containedInHeadingRule<Relationship, TestCtx, TestEdge>(
            "containedInHeading",
          ),
        ],
      }),
    ];

    // Every edge has the correct rel
    for (const e of edges) {
      assertEquals(e.rel, "containedInHeading");
    }

    // Each non-root node has at most one "containedInHeading" edge
    const containedMap = new Map<Node, TestEdge[]>();
    for (const e of edges) {
      const list = containedMap.get(e.from) ?? [];
      list.push(e);
      containedMap.set(e.from, list);
    }

    for (const [node, list] of containedMap.entries()) {
      if (node === root) continue;
      assert(
        list.length <= 1,
        "node should have at most one containedInHeading edge",
      );
    }
  });

  await t.step(
    "containedInHeadingRule - heading hierarchy reconstruction",
    () => {
      const edges = [
        ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
          prepareContext: () => baseCtx,
          rules: () => [
            containedInHeadingRule<Relationship, TestCtx, TestEdge>(
              "containedInHeading",
            ),
          ],
        }),
      ];

      const headings = collectHeadings(root);
      const byText = new Map<string, Heading>();
      for (const h of headings) {
        byText.set(headingText(h), h);
      }

      const h1 = byText.get("Heading 1");
      const h2 = byText.get("Heading 2");
      const s11 = byText.get("Subheading 1.1");
      const s111 = byText.get("Sub-subheading 1.1.1");
      const s12 = byText.get("Subheading 1.2");

      assert(h1);
      assert(h2);
      assert(s11);
      assert(s111);
      assert(s12);

      // Build parent->children map for heading relationships only
      const parentToChildren = new Map<Heading, Heading[]>();
      for (const e of edges) {
        const from = e.from as Heading;
        const to = e.to as Heading;
        if (from.type === "heading" && to.type === "heading") {
          const list = parentToChildren.get(to) ?? [];
          list.push(from);
          parentToChildren.set(to, list);
        }
      }

      const childrenOf = (parent: Heading): string[] =>
        (parentToChildren.get(parent) ?? []).map(headingText);

      assertEquals(childrenOf(h1), ["Subheading 1.1", "Subheading 1.2"]);
      assertEquals(childrenOf(s11), ["Sub-subheading 1.1.1"]);
      assertEquals(childrenOf(s12), []);
      assertEquals(childrenOf(h2), []);
    },
  );

  await t.step(
    "containedInSectionRule (heading-only) - basic invariants",
    () => {
      const edges = [
        ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
          prepareContext: () => baseCtx,
          rules: () => [
            containedInSectionRule<Relationship, TestCtx, TestEdge>(
              "containedInHeading",
              headingOnlySectionContainer,
            ),
          ],
        }),
      ];

      // Every edge has the correct rel
      for (const e of edges) {
        assertEquals(e.rel, "containedInHeading");
      }

      // Each non-root node has at most one "containedInHeading" edge
      const containedMap = new Map<Node, TestEdge[]>();
      for (const e of edges) {
        const list = containedMap.get(e.from) ?? [];
        list.push(e);
        containedMap.set(e.from, list);
      }

      for (const [node, list] of containedMap.entries()) {
        if (node === root) continue;
        assert(
          list.length <= 1,
          "node should have at most one containedInHeading edge",
        );
      }
    },
  );

  await t.step(
    "containedInSectionRule (heading-only) - heading hierarchy reconstruction",
    () => {
      const edges = [
        ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
          prepareContext: () => baseCtx,
          rules: () => [
            containedInSectionRule<Relationship, TestCtx, TestEdge>(
              "containedInHeading",
              headingOnlySectionContainer,
            ),
          ],
        }),
      ];

      const headings = collectHeadings(root);
      const byText = new Map<string, Heading>();
      for (const h of headings) {
        byText.set(headingText(h), h);
      }

      const h1 = byText.get("Heading 1");
      const h2 = byText.get("Heading 2");
      const s11 = byText.get("Subheading 1.1");
      const s111 = byText.get("Sub-subheading 1.1.1");
      const s12 = byText.get("Subheading 1.2");

      assert(h1);
      assert(h2);
      assert(s11);
      assert(s111);
      assert(s12);

      // Build parent->children map for heading relationships only
      const parentToChildren = new Map<Heading, Heading[]>();
      for (const e of edges) {
        const from = e.from as Heading;
        const to = e.to as Heading;
        if (from.type === "heading" && to.type === "heading") {
          const list = parentToChildren.get(to) ?? [];
          list.push(from);
          parentToChildren.set(to, list);
        }
      }

      const childrenOf = (parent: Heading): string[] =>
        (parentToChildren.get(parent) ?? []).map(headingText);

      assertEquals(childrenOf(h1), ["Subheading 1.1", "Subheading 1.2"]);
      assertEquals(childrenOf(s11), ["Sub-subheading 1.1.1"]);
      assertEquals(childrenOf(s12), []);
      assertEquals(childrenOf(h2), []);
    },
  );

  await t.step(
    "selectedNodesClassificationRule - selection and root->node edges",
    () => {
      const edges = [
        ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
          prepareContext: () => baseCtx,
          rules: () => [
            selectedNodesClassificationRule<
              Relationship,
              TestCtx,
              TestEdge
            >(
              "emphasis",
              "isImportant",
            ),
          ],
        }),
      ];

      // There should be exactly one emphasis node ("*important*")
      const importantEdges = edges.filter((e) => e.rel === "isImportant");
      assertEquals(importantEdges.length, 1);

      const [edge] = importantEdges;
      // From root to some emphasis node
      assert(edge.from === root);
      const emphasisNode = edge.to as { type?: string };
      assertEquals(emphasisNode.type, "emphasis");
    },
  );

  await t.step(
    "nodesClassificationRule - classify list items as tasks",
    () => {
      const edges = [
        ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
          prepareContext: () => baseCtx,
          rules: () => [
            nodesClassificationRule<Relationship, TestCtx, TestEdge>(
              "isTask",
              (node) => (node as { type?: string }).type === "listItem",
            ),
          ],
        }),
      ];

      const taskEdges = edges.filter((e) => e.rel === "isTask");
      // Our synthetic markdown has 4 list items total
      assertEquals(taskEdges.length, 4);

      for (const e of taskEdges) {
        assertEquals(
          (e.to as { type?: string }).type,
          "listItem",
        );
        assert(e.from === root);
      }
    },
  );

  await t.step(
    "pipeline with multiple rules via GraphRulesBuilder",
    () => {
      const builder = createGraphRulesBuilder<
        Relationship,
        TestCtx,
        TestEdge
      >();
      const rules = builder
        .use(
          containedInHeadingRule<Relationship, TestCtx, TestEdge>(
            "containedInHeading",
          ),
        )
        .use(
          selectedNodesClassificationRule<
            Relationship,
            TestCtx,
            TestEdge
          >(
            "emphasis",
            "isImportant",
          ),
        )
        .use(
          nodesClassificationRule<Relationship, TestCtx, TestEdge>(
            "isTask",
            (node) => (node as { type?: string }).type === "listItem",
          ),
        )
        .build();

      const edges = [
        ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
          prepareContext: () => baseCtx,
          rules: () => rules,
        }),
      ];

      // Sanity checks: we have some edges for each relationship
      const rels = new Set(edges.map((e) => e.rel));
      assert(rels.has("containedInHeading"));
      assert(rels.has("isImportant"));
      assert(rels.has("isTask"));
    },
  );
});

Deno.test("containedInSectionRule - heading-like paragraph containers", async (t) => {
  const root = parseMarkdown(headingLikeMarkdown);
  const ctx: TestCtx = { root };

  const edges = [
    ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
      prepareContext: () => ctx,
      rules: () => [
        containedInSectionRule<Relationship, TestCtx, TestEdge>(
          "containedInHeading",
          headingLikeSectionContainer,
        ),
      ],
    }),
  ];

  await t.step("all edges have correct relationship", () => {
    for (const e of edges) {
      assertEquals(e.rel, "containedInHeading");
    }
  });

  await t.step("each non-root node has at most one container", () => {
    const containedMap = new Map<Node, TestEdge[]>();
    for (const e of edges) {
      const list = containedMap.get(e.from) ?? [];
      list.push(e);
      containedMap.set(e.from, list);
    }

    for (const [node, list] of containedMap.entries()) {
      if (node === root) continue;
      assert(
        list.length <= 1,
        "node should have at most one containedInHeading edge",
      );
    }
  });

  await t.step("heading-like paragraphs are recognized as containers", () => {
    const containers = new Set<string>();

    for (const e of edges) {
      const to = e.to as Node;
      if (to.type === "paragraph") {
        const plain = nodePlainText(to).trim();
        if (plain.endsWith(":")) {
          containers.add(plain.slice(0, -1).trim());
        }
      }
    }

    // We should see all three labels:
    // - "**Alpha section**:"  → "Alpha section"
    // - "**Bravo section:**"  → "Bravo section"
    // - "Charlie section:"    → "Charlie section"
    assertEquals(
      Array.from(containers).sort(),
      ["Alpha section", "Bravo section", "Charlie section"].sort(),
    );
  });

  await t.step(
    "list items are contained in the last heading-like section",
    () => {
      // All list items in this fixture are under "Charlie section:"
      const listItemContainers = new Set<string>();

      for (const e of edges) {
        const from = e.from as Node;
        const to = e.to as Node;

        if (from.type === "listItem" && to.type === "paragraph") {
          const plain = nodePlainText(to).trim();
          if (plain.endsWith(":")) {
            listItemContainers.add(plain.slice(0, -1).trim());
          }
        }
      }

      assertEquals(Array.from(listItemContainers), ["Charlie section"]);
    },
  );
});

Deno.test("containedInSectionRule - mixed headings and heading-like sections", async (t) => {
  const root = parseMarkdown(mixedSectionMarkdown);
  const ctx: TestCtx = { root };

  const edges = [
    ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
      prepareContext: () => ctx,
      rules: () => [
        containedInSectionRule<Relationship, TestCtx, TestEdge>(
          "containedInHeading",
          headingLikeSectionContainer,
        ),
      ],
    }),
  ];

  // Helper: find the container of a specific paragraph by its plain text
  function containerLabelOfParagraph(searchText: string): string | undefined {
    let targetNode: Node | undefined;

    // Find the paragraph node with the given text
    const rootAny = root as unknown as { children?: Node[] };
    function findParagraph(n: Node) {
      if (n.type === "paragraph") {
        const text = nodePlainText(n).trim();
        if (text === searchText) {
          targetNode = n;
          return;
        }
      }
      const anyN = n as { children?: Node[] };
      if (Array.isArray(anyN.children)) {
        for (const c of anyN.children) {
          if (!targetNode) findParagraph(c);
        }
      }
    }
    if (Array.isArray(rootAny.children)) {
      for (const c of rootAny.children) {
        if (!targetNode) findParagraph(c);
      }
    }

    if (!targetNode) return undefined;

    for (const e of edges) {
      if (e.from === targetNode) {
        const container = e.to as Node;
        if (container.type === "heading") {
          return headingText(container);
        }
        if (container.type === "paragraph") {
          const plain = nodePlainText(container).trim();
          return plain.endsWith(":") ? plain.slice(0, -1).trim() : plain;
        }
      }
    }

    return undefined;
  }

  await t.step(
    "content before first heading-like paragraph belongs to real heading",
    () => {
      // There is no standalone paragraph between "# Real Heading 1" and
      // "**Alpha section**:", so this is mainly a sanity check that
      // we don't accidentally mis-attach anything. This step is left
      // minimal but present for future extensions.
      // (No assertion needed beyond ensuring the test runs without error.)
      assert(true);
    },
  );

  await t.step("Content A is contained in Alpha section", () => {
    const containerLabel = containerLabelOfParagraph("Content A under Alpha.");
    assertEquals(containerLabel, "Alpha section");
  });

  await t.step("Content B is contained in Bravo section", () => {
    const containerLabel = containerLabelOfParagraph("Content B under Bravo.");
    assertEquals(containerLabel, "Bravo section");
  });
});

Deno.test("graph domain rules - edge cases", async (t) => {
  await t.step("containedInHeadingRule - no headings yields no edges", () => {
    const md = `
Plain paragraph.

Another paragraph.
`;
    const root = parseMarkdown(md);
    const ctx: TestCtx = { root };

    const edges = [
      ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
        prepareContext: () => ctx,
        rules: () => [
          containedInHeadingRule<Relationship, TestCtx, TestEdge>(
            "containedInHeading",
          ),
        ],
      }),
    ];

    assertEquals(edges.length, 0);
  });

  await t.step(
    "selectedNodesClassificationRule - selector with no matches",
    () => {
      const root = parseMarkdown("Just **bold**, no emphasis.");
      const ctx: TestCtx = { root };

      const edges = [
        ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
          prepareContext: () => ctx,
          rules: () => [
            selectedNodesClassificationRule<
              Relationship,
              TestCtx,
              TestEdge
            >(
              "emphasis",
              "isImportant",
            ),
          ],
        }),
      ];

      assertEquals(edges.length, 0);
    },
  );
});

Deno.test("codeDependencyRule - dependency graph across code blocks", async (t) => {
  const md = `
\`\`\`js name=A
console.log("A");
\`\`\`

\`\`\`js name=B
console.log("B");
\`\`\`

\`\`\`js name=C
console.log("C");
\`\`\`

\`\`\`js name=D deps=B,C
console.log("D depends on B and C");
\`\`\`
`;

  const root = unified().use(remarkParse).parse(md) as Root;
  const ctx: TestCtx = { root };

  //
  // Helper: extract fence info, example: "js name=A deps=B,C"
  //
  function parseInfo(info: string): Record<string, string> {
    const parts = info.split(/\s+/).map((p) => p.trim());
    const out: Record<string, string> = {};
    for (const part of parts) {
      if (part.includes("=")) {
        const [k, v] = part.split("=");
        out[k] = v;
      }
    }
    return out;
  }

  //
  // Identify code nodes
  //
  const isCode = (node: Node): boolean => node.type === "code";

  //
  // Identify code blocks by name, e.g., name=A
  //
  const isCodeName = (node: Node, name: string): boolean => {
    if (node.type !== "code") return false;
    const code = node as unknown as { lang?: string; meta?: string };
    if (!code.meta) return false;

    const parsed = parseInfo(code.meta);
    return parsed.name === name;
  };

  //
  // codeDeps: return list of dependency names (if any)
  //
  const codeDeps = (node: Node): string | string[] | false => {
    if (node.type !== "code") return false;
    const code = node as unknown as { meta?: string };
    if (!code.meta) return false;

    const parsed = parseInfo(code.meta);
    if (!parsed.deps) return false;

    return parsed.deps.split(",").map((d) => d.trim()).filter(Boolean);
  };

  //
  // Run pipeline
  //
  const edges = [
    ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
      prepareContext: () => ctx,
      rules: () => [
        nodeDependencyRule<Relationship, TestCtx, TestEdge>(
          "codeDependsOn",
          isCode,
          isCodeName,
          codeDeps,
        ),
      ],
    }),
  ];

  // Collect dependencies into map: fromName → [toNames]
  const depMap = new Map<string, string[]>();
  for (const e of edges) {
    // deno-lint-ignore no-explicit-any
    const from = e.from as any;
    // deno-lint-ignore no-explicit-any
    const to = e.to as any;

    const fromName = parseInfo(from.meta ?? "").name;
    const toName = parseInfo(to.meta ?? "").name;

    const list = depMap.get(fromName) ?? [];
    list.push(toName);
    depMap.set(fromName, list);
  }

  //
  // Assertions
  //

  await t.step("D depends on B and C", () => {
    assertEquals(depMap.get("D")?.sort(), ["B", "C"].sort());
  });

  await t.step("A, B, C have no dependencies", () => {
    assertEquals(depMap.get("A"), undefined);
    assertEquals(depMap.get("B"), undefined);
    assertEquals(depMap.get("C"), undefined);
  });

  await t.step("Relationship name is correct", () => {
    for (const e of edges) assertEquals(e.rel, "codeDependsOn");
  });
});

Deno.test("sectionFrontmatterRule - yaml/json code as section frontmatter", async (t) => {
  const md = `
# Heading 1

\`\`\`yaml
title: H1 frontmatter
order: 1
\`\`\`

Paragraph under H1.

## Subheading 1.1

\`\`\`json
{ "title": "Sub 1.1 frontmatter", "order": 2 }
\`\`\`

Some more content.

## Subheading 1.2

\`\`\`js
console.log("not frontmatter");
\`\`\`
`;

  const root = parseMarkdown(md);
  const ctx: TestCtx = { root };

  // We already have these helpers defined earlier in the file:
  // - headingOnlySectionContainer (treats only real headings as containers)
  // - headingText(root: Node): string

  const edges = [
    ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
      prepareContext: () => ctx,
      rules: () => [
        // First: attach nodes to headings
        containedInSectionRule<Relationship, TestCtx, TestEdge>(
          "containedInHeading",
          headingOnlySectionContainer,
        ),
        // Then: watch those edges and emit "frontmatter" edges
        sectionFrontmatterRule<Relationship, TestCtx, TestEdge>(
          "frontmatter",
          ["containedInHeading"] as Relationship[],
        ),
      ],
    }),
  ];

  // Separate out the edges we care about
  const containedEdges = edges.filter((e) => e.rel === "containedInHeading");
  const frontmatterEdges = edges.filter((e) => e.rel === "frontmatter");

  await t.step("frontmatter edges exist only for yaml/json code blocks", () => {
    // We expect exactly 2 frontmatter edges:
    // - the yaml block under Heading 1
    // - the json block under Subheading 1.1
    assertEquals(frontmatterEdges.length, 2);

    for (const e of frontmatterEdges) {
      const from = e.from as { type?: string; lang?: string | null };
      const to = e.to as Node;

      assertEquals(from.type, "code");
      const lang = (from.lang ?? "").toLowerCase();
      assert(lang === "yaml" || lang === "yml" || lang === "json");

      // The target should be a heading container
      assertEquals((to as { type?: string }).type, "heading");
    }
  });

  await t.step("frontmatter edges match their correct headings", () => {
    // Build a simple mapping: headingText(from-heading) → langs of frontmatter blocks
    const headingToFrontmatterLangs = new Map<string, string[]>();

    for (const e of frontmatterEdges) {
      const from = e.from as { lang?: string | null };
      const to = e.to as Node;

      const hText = headingText(to);
      const list = headingToFrontmatterLangs.get(hText) ?? [];
      list.push((from.lang ?? "").toLowerCase());
      headingToFrontmatterLangs.set(hText, list);
    }

    assertEquals(
      headingToFrontmatterLangs.get("Heading 1") ?? [],
      ["yaml"],
    );
    assertEquals(
      headingToFrontmatterLangs.get("Subheading 1.1") ?? [],
      ["json"],
    );
    // Subheading 1.2 has a JS block only → no frontmatter
    assertEquals(headingToFrontmatterLangs.get("Subheading 1.2"), undefined);
  });

  await t.step("non-yaml/json code does not get frontmatter edges", () => {
    // There is exactly one JS code block, and it should have only a
    // 'containedInHeading' edge but no 'frontmatter' edge.
    const jsCodeNodes = new Set<Node>();
    for (const e of containedEdges) {
      const from = e.from as { type?: string; lang?: string | null };
      if (from.type === "code" && (from.lang ?? "").toLowerCase() === "js") {
        jsCodeNodes.add(e.from);
      }
    }

    // Sanity: we actually found the JS code node
    assertEquals(jsCodeNodes.size, 1);

    for (const jsNode of jsCodeNodes) {
      const jsFrontmatterEdges = frontmatterEdges.filter((e) =>
        e.from === jsNode
      );
      assertEquals(jsFrontmatterEdges.length, 0);
    }
  });
});

Deno.test("frontmatterClassificationRule - doc-classify roles", () => {
  const root = parseMarkdown(syntheticMarkdown);
  const ctx: TestCtx = { root };

  // Simulated parsed frontmatter
  const frontmatter: Record<string, unknown> = {
    "doc-classify": [
      { select: 'heading[depth="1"]', role: "project" },
      { select: 'heading[depth="2"]', role: "strategy" },
      { select: 'heading[depth="3"]', role: "plan" },
      // Depths 4–6 are fine to include even if not present in this doc
      { select: 'heading[depth="4"]', role: "suite" },
      { select: 'heading[depth="5"]', role: "case" },
      { select: 'heading[depth="6"]', role: "evidence" },
    ],
  };

  const edges = [
    ...astGraphEdges<Relationship, TestEdge, TestCtx>(root, {
      prepareContext: () => ctx,
      rules: () => [
        frontmatterClassificationRule<Relationship, TestCtx, TestEdge>(
          "doc-classify",
          frontmatter,
        ),
      ],
    }),
  ];

  // Helper: map heading node → list of relationship strings
  const headingRoles = new Map<Heading, string[]>();

  for (const e of edges) {
    assert(e.from === root, "frontmatter roles should be from root");
    const to = e.to as Node;
    if (to.type === "heading") {
      const h = to as Heading;
      const list = headingRoles.get(h) ?? [];
      list.push(String(e.rel));
      headingRoles.set(h, list);
    }
  }

  const headings = collectHeadings(root);

  // Build a by-text map for convenience
  const byText = new Map<string, Heading>();
  for (const h of headings) {
    byText.set(headingText(h), h);
  }

  const h1 = byText.get("Heading 1");
  const h2 = byText.get("Heading 2");
  const s11 = byText.get("Subheading 1.1");
  const s111 = byText.get("Sub-subheading 1.1.1");
  const s12 = byText.get("Subheading 1.2");

  assert(h1);
  assert(h2);
  assert(s11);
  assert(s111);
  assert(s12);

  const rolesOf = (h: Heading): string[] => (headingRoles.get(h) ?? []).sort();

  // Depth 1 headings → role:project
  assertEquals(rolesOf(h1), ["role:project"]);
  assertEquals(rolesOf(h2), ["role:project"]);

  // Depth 2 headings → role:strategy
  assertEquals(rolesOf(s11), ["role:strategy"]);
  assertEquals(rolesOf(s12), ["role:strategy"]);

  // Depth 3 heading → role:plan
  assertEquals(rolesOf(s111), ["role:plan"]);

  // No headings at depths 4–6 in this fixture, so no extra roles produced
  // (implicitly covered by the above checks).
});
