import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { toMarkdown } from "mdast-util-to-markdown";
import { Heading, Paragraph } from "types/mdast";
import { queryPosixPI } from "../../universal/posix-pi.ts";
import { codeFrontmatterNDF } from "../mdast/code-frontmatter.ts";
import { graphEdgesTree, headingsTreeText } from "./graph-tree.ts";
import {
  astGraphEdges,
  containedInHeadingRule,
  containedInSectionRule,
  createGraphRulesBuilder,
  defineRelationships,
  frontmatterClassificationRule,
  Graph,
  GraphEdge,
  graphToDot,
  headingLikeTextDef,
  headingText,
  isBoldSingleLineParagraph,
  isColonSingleLineParagraph,
  IsSectionContainer,
  nodeDependencyRule,
  nodesClassificationRule,
  RuleContext,
  sectionFrontmatterRule,
  selectedNodesClassificationRule,
} from "./graph.ts";
import { markdownASTs } from "./io.ts";

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
      mdLabel: toMarkdown(node as Heading), // TODO: stringify the node
    };
  }

  if (node.type !== "paragraph") return false;

  const candidate = isBoldSingleLineParagraph(node as Paragraph) ??
    isColonSingleLineParagraph(node as Paragraph);

  if (candidate == false) return false;

  headingLikeTextDef.factory.attach(node, true);
  return {
    nature: "section",
    ...candidate,
  };
};

Deno.test("Ontology Graphs and Edges test", async () => {
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
    containedInHeading: 1172,
    frontmatter: 12,
    containedInSection: 1172,
    isTask: 175,
    "role:case": 8,
    "role:evidence": 6,
    "role:plan": 6,
    "role:project": 1,
    "role:strategy": 8,
    "role:suite": 6,
    // deno-lint-ignore no-explicit-any
  } as any);

  const geTree = graphEdgesTree<Relationship, TestEdge>(edges, {
    relationships: ["containedInSection"],
  });
  assertEquals(
    headingsTreeText(geTree, false),
    await Deno.readTextFile(
      fromFileUrl(import.meta.resolve("./mod_test-fixture-01.txt.golden")),
    ),
  );
});
