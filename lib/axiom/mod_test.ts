import { assert, assertEquals, assertFalse } from "@std/assert";
import { inspect } from "unist-util-inspect";
import { graphEdgesTree, headingsTreeText, typicalRules } from "./edge/mod.ts";
import { fixturesFactory } from "./fixture/mod.ts";
import {
  astGraphEdges,
  Graph,
  graphToDot,
  MarkdownEncountered,
} from "./mod.ts";
import { flexibleProjectionFromFiles } from "./projection/flexible.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const ff = fixturesFactory(import.meta.resolve, "./fixture");
const fixtures = {
  ...ff,
  comprehensiveMdPath: ff.pmdPath("comprehensive.md"),
};

Deno.test(`Axiom regression / smoke test of ${ff.relToCWD(fixtures.comprehensiveMdPath)}`, async (t) => {
  const f = {
    comprehensive: {
      projection: "mod_test.ts-comprehensive.md-projection.json",
      graphDot: "mod_test.ts-comprehensive.md-graph.dot",
      inspect: "mod_test.ts-comprehensive.md-inspect.txt",
    },
  };

  let comprehensive: MarkdownEncountered;
  const fpff = await flexibleProjectionFromFiles(
    [fixtures.comprehensiveMdPath],
    (encountered) => {
      // expecting only a single document
      assertFalse(comprehensive);
      comprehensive = encountered;
    },
  );

  assert(comprehensive!);
  const { mdastRoot: root } = comprehensive;

  await t.step(
    `validate stable projection via JSON in ${
      ff.relToCWD(f.comprehensive.projection)
    }`,
    async () => {
      // when required, uncomment to store stable "golden" version as a JSON file
      // await fixtures.goldenJSON(f.comprehensive.projection, fpff);
      assertEquals(
        JSON.stringify(fpff), // comparing string to string since the file is large
        await fixtures.goldenText(f.comprehensive.projection),
      );
    },
  );

  await t.step(
    `validate stable mdast tree via 'inspect' output in ${
      ff.relToCWD(f.comprehensive.inspect)
    }`,
    async () => {
      // when required, uncomment to store stable "golden" version as a text file:
      // await fixtures.goldenText(f.comprehensive.inspect, inspect(root));
      assertEquals(
        inspect(root),
        await fixtures.goldenText(f.comprehensive.inspect),
      );
    },
  );

  const graph: Graph<Any, Any> = {
    root,
    edges: Array.from(astGraphEdges(root, {
      prepareContext: () => ({ root }),
      rules: () => typicalRules(),
    })),
  };

  await t.step(
    `validate stable graph edges via GraphViz dot in ${
      ff.relToCWD(f.comprehensive.graphDot)
    }`,
    async () => {
      // when required, uncomment to store stable "golden" version of the edge in GraphViz dot format
      // await fixtures.goldenText(f.comprehensive.graphDot, graphToDot(graph));
      assertEquals(
        graphToDot(graph),
        await fixtures.goldenText(f.comprehensive.graphDot),
      );
    },
  );

  await t.step(`smoke test relations and headings`, () => {
    const rels = new Set(graph.edges.map((e) => e.rel));
    assertEquals(Array.from(rels), [
      "containedInSection",
      "sectionSemanticId",
      "frontmatter",
      "role:project",
      "role:strategy",
      "role:plan",
      "role:suite",
      "role:case",
      "role:evidence",
      "isCode",
      "isSpawnableCodeCandidate",
      "isPartial",
      "isTask",
    ]);

    const relCounts = graph.edges.reduce(
      (acc, e) => ((acc[e.rel] = (acc[e.rel] ?? 0) + 1), acc),
      {} as Record<Any, number>,
    );
    assertEquals(relCounts, {
      frontmatter: 12,
      containedInSection: 1172,
      isTask: 175,
      "role:case": 8,
      "role:evidence": 6,
      "role:plan": 6,
      "role:project": 1,
      "role:strategy": 8,
      "role:suite": 6,
      isCode: 16,
      isPartial: 2,
      isSpawnableCodeCandidate: 13,
      sectionSemanticId: 34,
      // deno-lint-ignore no-explicit-any
    } as any);

    const geTree = graphEdgesTree(graph.edges, {
      relationships: ["containedInSection"],
    });
    assertEquals(headingsTreeText(geTree, false), headingsTreeGolden);
  });
});

const headingsTreeGolden = `
- containedInSection
  heading: #1 Spry remark ecosystem Test Fixture 01
  ├─ paragraph: Objectives
  ├─ paragraph: Risks
  ├─ heading: #2 Plugin Orchestration Strategy
  │  ├─ paragraph: Doc frontmatter plugin
  │  ├─ paragraph: Heading frontmatter plugin
  │  ├─ paragraph: Node classification plugin
  │  ├─ paragraph: Node identities plugin
  │  ├─ paragraph: Code annotations plugin
  │  ├─ paragraph: Code frontmatter plugin
  │  ├─ paragraph: Code partial plugin
  │  ├─ paragraph: Code injection plugin
  │  └─ paragraph: Key Goals
  ├─ heading: #2 Node Classification & Doc Frontmatter Strategy
  │  ├─ paragraph: Doc Frontmatter Plugin Behavior
  │  ├─ paragraph: Node Classification Plugin Behavior
  │  └─ heading: #3 Node Classification Verification Plan
  │     ├─ paragraph: Cycle Goals
  │     └─ heading: #4 Node Classification Visibility Suite
  │        ├─ paragraph: Scope
  │        └─ heading: #5 Verify headings are classified according to doc frontmatter rules
  │           ├─ paragraph: Description
  │           ├─ paragraph: Preconditions
  │           ├─ paragraph: Steps
  │           ├─ paragraph: Expected Results
  │           └─ heading: #6 Evidence
  │              └─ paragraph: Attachment
  ├─ heading: #2 Node Identities & Heading Frontmatter Strategy
  │  └─ heading: #3 Node Identity & Heading Frontmatter Plan
  │     ├─ paragraph: Cycle Goals
  │     └─ heading: #4 Node Identity Suite
  │        └─ heading: #5 Verify @id markers bind to nearest semantic node
  │           ├─ paragraph: Description
  │           ├─ paragraph: Preconditions
  │           ├─ paragraph: Steps
  │           ├─ paragraph: Expected Results
  │           └─ heading: #6 Evidence
  │              └─ paragraph: Attachment
  ├─ heading: #2 Code Annotations & Code Frontmatter Strategy
  │  └─ heading: #3 Code Metadata Verification Plan
  │     └─ heading: #4 Code Metadata Suite
  │        └─ heading: #5 Verify code annotations and code frontmatter are both attached
  │           ├─ paragraph: Description
  │           ├─ paragraph: Synthetic Example Code Cell
  │           ├─ paragraph: Preconditions
  │           ├─ paragraph: Steps
  │           ├─ paragraph: Expected Results
  │           └─ heading: #6 Evidence
  ├─ heading: #2 Code Partials & Code Injection Strategy
  │  └─ heading: #3 Partial & Injection Plan
  │     └─ heading: #4 Partial Library Suite
  │        ├─ heading: #5 Define a reusable TypeScript partial
  │        ├─ heading: #5 Define a reusable Markdown partial for use with directives
  │        └─ heading: #5 Inject the partial into another cell by logical ID
  │           ├─ paragraph: Description
  │           ├─ paragraph: Preconditions
  │           ├─ paragraph: Steps
  │           ├─ paragraph: Expected Results
  │           └─ heading: #6 Evidence
  ├─ heading: #2 Doc Schema Strategy
  │  └─ heading: #3 Doc Schema Validation Plan
  │     └─ heading: #4 Schema Compliance Suite
  │        └─ heading: #5 Validate project-level schema
  │           ├─ paragraph: Description
  │           ├─ paragraph: Preconditions
  │           ├─ paragraph: Steps
  │           ├─ paragraph: Expected Results
  │           └─ heading: #6 Evidence
  ├─ heading: #2 mdast-io Round-Trip Strategy
  │  └─ heading: #3 mdast-io Round-Trip Plan
  │     └─ heading: #4 Round-Trip Integrity Suite
  │        └─ heading: #5 Verify mdast-io preserves plugin metadata across round-trip
  │           ├─ paragraph: Description
  │           ├─ paragraph: Preconditions
  │           ├─ paragraph: Steps
  │           ├─ paragraph: Expected Results
  │           └─ heading: #6 Evidence
  │              └─ paragraph: Attachment
  └─ heading: #2 Summary`.trim();
