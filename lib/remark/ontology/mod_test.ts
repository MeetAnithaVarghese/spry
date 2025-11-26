import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { Node } from "types/unist";
import { queryPosixPI } from "../../universal/posix-pi.ts";
import { markdownASTs } from "../mdastctl/io.ts";
import { codeFrontmatterNDF } from "../plugin/node/code-frontmatter.ts";
import { headingText, nodePlainText, visitGraph } from "./graph-visit.ts";
import {
  astGraphEdges,
  buildHierarchyTrees,
  containedInHeadingRule,
  containedInSectionRule,
  createGraphRulesBuilder,
  defineRelationships,
  frontmatterClassificationRule,
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
  "role:project",
  "role:strategy",
  "role:plan",
  "role:suite",
  "role:case",
  "role:evidence",
);
type Relationship = (typeof relationships)[number];

type TestEdge = GraphEdge<Relationship>;
type TestCtx = RuleContext;

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

Deno.test("Ontology Graphs and Edges test", async (t) => {
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
    .use(
      frontmatterClassificationRule<Relationship, TestCtx, TestEdge>(
        "doc-classify",
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
        if (!codeFrontmatterNDF.is(node)) return false;
        return node.data.codeFM.pi.pos[0] == name;
      },
      (node) => {
        if (!codeFrontmatterNDF.is(node)) return false;
        const qf = queryPosixPI(node.data.codeFM.pi);
        const deps = qf.getTextFlagValues("dep");
        return deps.length > 0 ? deps : false;
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

  const graph = graphs[0];
  const { edges } = graph;
  assert(edges);

  assert(edges.length);

  assert(graphToDot(graphs[0]));

  const rels = new Set(edges.map((e) => e.rel));
  assertEquals(Array.from(rels), [
    "containedInHeading",
    "frontmatter",
    "containedInSection",
    "role:project",
    "role:strategy",
    "role:plan",
    "role:suite",
    "role:case",
    "role:evidence",
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
    "role:case": 8,
    "role:evidence": 6,
    "role:plan": 6,
    "role:project": 1,
    "role:strategy": 8,
    "role:suite": 6,
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

  const relTexts = edges.reduce(
    (acc, e) => {
      const labelOf = (node: Node): string =>
        (node as { type?: string }).type === "heading"
          ? headingText(node)
          : nodePlainText(node);

      const entry = {
        from: labelOf(e.from),
        to: labelOf(e.to),
      };

      (acc[e.rel] ??= []).push(entry);
      return acc;
    },
    {} as Record<Relationship, { from: string; to: string }[]>,
  );

  assert(relTexts["role:project"]);
  assert(relTexts["role:strategy"]);
  assert(relTexts["role:suite"]);
  assert(relTexts["role:plan"]);
  assert(relTexts["role:case"]);
  assert(relTexts["role:evidence"]);

  await t.step("Vist all relationships and edges", () => {
    visitGraph(graph, (_rel, _edge) => {
      // console.log(rel, ":", headingText(edge.from), "→", headingText(edge.to));
      // count or collect nodes
    });
  });

  await t.step("Vist specific relationship and sort headings by label", () => {
    visitGraph(
      graph,
      (_rel, _edge) => {
        // TODO: add count or something
      },
      {
        test: "role:strategy",
        edgeOrder: "from",
      },
    );
  });
});
