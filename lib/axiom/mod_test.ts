import { assert, assertEquals } from "@std/assert";
import { toMarkdown } from "mdast-util-to-markdown";
import { Heading, Paragraph } from "types/mdast";
import { queryPosixPI } from "../universal/posix-pi.ts";
import {
  astGraphEdges,
  GraphEdge,
  graphEdgesTree,
  headingsTreeText,
} from "./edge/mod.ts";
import {
  containedInHeadingRule,
  containedInSectionRule,
  createGraphRulesBuilder,
  defineRelationships,
  frontmatterClassificationRule,
  headingLikeNodeDataBag,
  isBoldSingleLineParagraph,
  isColonSingleLineParagraph,
  IsSectionContainer,
  nodeDependencyRule,
  nodesClassificationRule,
  RuleContext,
  sectionFrontmatterRule,
  selectedNodesClassificationRule,
} from "./edge/rule/mod.ts";
import { fixturesFactory } from "./fixture/mod.ts";
import { Graph, graphToDot } from "./graph.ts";
import { markdownASTs } from "./io/mod.ts";
import { codeFrontmatter } from "./mdast/code-frontmatter.ts";
import { headingText } from "./mdast/node-content.ts";

const ff = fixturesFactory(import.meta.resolve, "./fixture");
const fixtures = {
  ...ff,
  comprehensiveMdPath: ff.pmdPath("comprehensive.md"),
};

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

  headingLikeNodeDataBag.attach(node, true);
  return {
    nature: "section",
    ...candidate,
  };
};

Deno.test(`Axiom regression / smoke test of ${ff.relToCWD(fixtures.comprehensiveMdPath)}`, async () => {
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
        const codeFM = codeFrontmatter(node);
        if (!codeFM) return false;
        return codeFM.pi.pos[0] == name;
      },
      (node) => {
        const codeFM = codeFrontmatter(node);
        if (!codeFM) return false;
        const qf = queryPosixPI(codeFM.pi);
        const deps = qf.getTextFlagValues("dep");
        return deps.length > 0 ? deps : false;
      },
    ))
    .build();

  const graphs: Graph<Relationship, TestEdge>[] = [];
  for await (
    const viewable of markdownASTs([fixtures.comprehensiveMdPath])
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
  assertEquals(headingsTreeText(geTree, false), headingsTreeGolden);
});

const headingsTreeGolden = `
- containedInSection
  heading:#1 Spry remark ecosystem Test Fixture 01
  ├─ paragraph:Objectives
  ├─ paragraph:Risks
  ├─ heading:#2 Plugin Orchestration Strategy
  │  ├─ paragraph:Doc frontmatter plugin
  │  ├─ paragraph:Heading frontmatter plugin
  │  ├─ paragraph:Node classification plugin
  │  ├─ paragraph:Node identities plugin
  │  ├─ paragraph:Code annotations plugin
  │  ├─ paragraph:Code frontmatter plugin
  │  ├─ paragraph:Code partial plugin
  │  ├─ paragraph:Code injection plugin
  │  └─ paragraph:Key Goals
  ├─ heading:#2 Node Classification & Doc Frontmatter Strategy
  │  ├─ paragraph:Doc Frontmatter Plugin Behavior
  │  ├─ paragraph:Node Classification Plugin Behavior
  │  └─ heading:#3 Node Classification Verification Plan
  │     ├─ paragraph:Cycle Goals
  │     └─ heading:#4 Node Classification Visibility Suite
  │        ├─ paragraph:Scope
  │        └─ heading:#5 Verify headings are classified according to doc frontmatter rules
  │           ├─ paragraph:Description
  │           ├─ paragraph:Preconditions
  │           ├─ paragraph:Steps
  │           ├─ paragraph:Expected Results
  │           └─ heading:#6 Evidence
  │              └─ paragraph:Attachment
  ├─ heading:#2 Node Identities & Heading Frontmatter Strategy
  │  └─ heading:#3 Node Identity & Heading Frontmatter Plan
  │     ├─ paragraph:Cycle Goals
  │     └─ heading:#4 Node Identity Suite
  │        └─ heading:#5 Verify @id markers bind to nearest semantic node
  │           ├─ paragraph:Description
  │           ├─ paragraph:Preconditions
  │           ├─ paragraph:Steps
  │           ├─ paragraph:Expected Results
  │           └─ heading:#6 Evidence
  │              └─ paragraph:Attachment
  ├─ heading:#2 Code Annotations & Code Frontmatter Strategy
  │  └─ heading:#3 Code Metadata Verification Plan
  │     └─ heading:#4 Code Metadata Suite
  │        └─ heading:#5 Verify code annotations and code frontmatter are both attached
  │           ├─ paragraph:Description
  │           ├─ paragraph:Synthetic Example Code Cell
  │           ├─ paragraph:Preconditions
  │           ├─ paragraph:Steps
  │           ├─ paragraph:Expected Results
  │           └─ heading:#6 Evidence
  ├─ heading:#2 Code Partials & Code Injection Strategy
  │  └─ heading:#3 Partial & Injection Plan
  │     └─ heading:#4 Partial Library Suite
  │        ├─ heading:#5 Define a reusable TypeScript partial
  │        ├─ heading:#5 Define a reusable Markdown partial for use with directives
  │        └─ heading:#5 Inject the partial into another cell by logical ID
  │           ├─ paragraph:Description
  │           ├─ paragraph:Preconditions
  │           ├─ paragraph:Steps
  │           ├─ paragraph:Expected Results
  │           └─ heading:#6 Evidence
  ├─ heading:#2 Doc Schema Strategy
  │  └─ heading:#3 Doc Schema Validation Plan
  │     └─ heading:#4 Schema Compliance Suite
  │        └─ heading:#5 Validate project-level schema
  │           ├─ paragraph:Description
  │           ├─ paragraph:Preconditions
  │           ├─ paragraph:Steps
  │           ├─ paragraph:Expected Results
  │           └─ heading:#6 Evidence
  ├─ heading:#2 mdast-io Round-Trip Strategy
  │  └─ heading:#3 mdast-io Round-Trip Plan
  │     └─ heading:#4 Round-Trip Integrity Suite
  │        └─ heading:#5 Verify mdast-io preserves plugin metadata across round-trip
  │           ├─ paragraph:Description
  │           ├─ paragraph:Preconditions
  │           ├─ paragraph:Steps
  │           ├─ paragraph:Expected Results
  │           └─ heading:#6 Evidence
  │              └─ paragraph:Attachment
  └─ heading:#2 Summary`.trim();
