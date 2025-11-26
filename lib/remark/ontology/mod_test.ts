import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { Heading, Text } from "types/mdast";
import { Node } from "types/unist";
import { markdownASTs } from "../mdastctl/io.ts";
import {
  astGraphEdges,
  buildHierarchyTrees,
  containedInHeadingRule,
  containedInSectionRule,
  createGraphRulesBuilder,
  defineRelationships,
  Graph,
  GraphEdge,
  graphToDot,
  IsSectionContainer,
  nodeDependencyRule,
  nodesClassificationRule,
  RuleContext,
  sectionFrontmatterRule,
  selectedNodesClassificationRule,
} from "./graph.ts";

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
const _headingOnlySectionContainer: IsSectionContainer = (node) => {
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

Deno.test("Graph test", async () => {
  const builder = createGraphRulesBuilder<Relationship, TestCtx, TestEdge>();
  const rules = builder
    .use(
      containedInHeadingRule<Relationship, TestCtx, TestEdge>(
        "containedInHeading",
      ),
    )
    .use(containedInSectionRule<Relationship, TestCtx, TestEdge>(
      "containedInSection",
      headingLikeSectionContainer,
    ))
    .use( // Then: watch those edges and emit "frontmatter" edges
      sectionFrontmatterRule<Relationship, TestCtx, TestEdge>(
        "frontmatter",
        ["containedInHeading"] as Relationship[],
      ),
    )
    .use(selectedNodesClassificationRule<Relationship, TestCtx, TestEdge>(
      "emphasis",
      "isImportant",
    ))
    .use(
      nodesClassificationRule<Relationship, TestCtx, TestEdge>(
        "isTask",
        (node) => (node as { type?: string }).type === "listItem",
      ),
    )
    .use(nodeDependencyRule<Relationship, TestCtx, TestEdge>(
      "codeDependsOn",
      (node): boolean => node.type === "code",
      (node, name): boolean => {
        if (node.type !== "code") return false;
        const code = node as unknown as { lang?: string; meta?: string };
        if (!code.meta) return false;

        const parsed = parseInfo(code.meta);
        return parsed.name === name;
      },
      (node) => {
        if (node.type !== "code") return false;
        const code = node as unknown as { meta?: string };
        if (!code.meta) return false;

        const parsed = parseInfo(code.meta);
        if (!parsed.deps) return false;

        return parsed.deps.split(",").map((d) => d.trim()).filter(Boolean);
      },
    ))
    .build();

  const graphs: Graph<Relationship, TestEdge>[] = [];
  for await (
    const viewable of markdownASTs([
      fromFileUrl(
        new URL("../fixture/test-fixture-01.md", import.meta.url).href,
      ),
    ])
  ) {
    const edges: TestEdge[] = [];
    const baseCtx: TestCtx = { root: viewable.mdastRoot };

    edges.push(
      ...astGraphEdges<Relationship, TestEdge, TestCtx>(viewable.mdastRoot, {
        prepareContext: () => baseCtx,
        rules: () => rules,
      }),
    );

    graphs.push({ root: viewable.mdastRoot, edges });
  }

  const { edges } = graphs[0];
  assert(edges);

  assert(edges.length);

  assert(graphToDot(graphs[0]));

  const rels = new Set(edges.map((e) => e.rel));
  assertEquals(Array.from(rels), [
    "containedInHeading",
    "frontmatter",
    "containedInSection",
    "isTask",
  ]);

  const relCounts = edges.reduce(
    (acc, e) => ((acc[e.rel] = (acc[e.rel] ?? 0) + 1), acc),
    {} as Record<Relationship, number>,
  );
  assertEquals(relCounts, {
    containedInHeading: 1138,
    frontmatter: 12,
    containedInSection: 1117,
    isTask: 175,
    // deno-lint-ignore no-explicit-any
  } as any);

  // TODO: figure out why trees aren't working -- probably need two-way rels?

  assert(buildHierarchyTrees<Relationship, TestEdge>(
    "containedInHeading",
    edges,
  ));

  assert(buildHierarchyTrees<Relationship, TestEdge>(
    "containedInSection",
    edges,
  ));
});
