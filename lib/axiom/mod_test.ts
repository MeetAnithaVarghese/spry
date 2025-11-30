import { assert, assertEquals } from "@std/assert";
import { inspect } from "unist-util-inspect";
import { graphEdgesTree, headingsTreeText } from "./edge/mod.ts";
import { fixturesFactory } from "./fixture/mod.ts";
import { graph, GraphEdge, graphToDot, MarkdownEncountered } from "./mod.ts";
import { flexibleProjectionFromFiles } from "./projection/flexible.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const ff = fixturesFactory(import.meta.resolve, "./fixture");
const fixtures = {
  ...ff,
  comprehensiveMdPath: ff.pmdPath("comprehensive.md"),
  runbook1MdPath: ff.pmdPath("runbook-01.md"),
  runbook2MdPath: ff.pmdPath("runbook-02.md"),
  runbook3MdPath: ff.pmdPath("runbook-03.md"),
  runbook4MdPath: ff.pmdPath("runbook-04.md"),
};

Deno.test(`Axiom regression / smoke test`, async (t) => {
  const f = {
    comprehensive: {
      projection: "mod_test.ts-comprehensive.md-projection.json",
      graphDot: "mod_test.ts-comprehensive.md-graph.dot",
      inspect: "mod_test.ts-comprehensive.md-inspect.txt",
    },
  };

  const me: MarkdownEncountered[] = [];
  const fpff = await flexibleProjectionFromFiles(
    [
      fixtures.comprehensiveMdPath, // always keep this first
      fixtures.runbook1MdPath,
      fixtures.runbook2MdPath,
      fixtures.runbook3MdPath,
      fixtures.runbook4MdPath,
    ],
    (encountered) => me.push(encountered),
  );

  await t.step(ff.relToCWD(fixtures.comprehensiveMdPath), async (s) => {
    const [comprehensive] = me;

    assert(comprehensive);
    const { mdastRoot: root } = comprehensive;
    const gr = graph(root);

    // when required, set to true to store stable "golden" versions
    const generateGoldens = false;

    await s.step(
      `validate stable projection via JSON in ${
        ff.relToCWD(f.comprehensive.projection)
      }`,
      async () => {
        // when required, use this to store stable "golden" version as a JSON file
        if (generateGoldens) {
          await fixtures.goldenJSON(f.comprehensive.projection, fpff);
          console.warn(
            `This test run is invalid since ${
              ff.relToCWD(f.comprehensive.projection)
            } is being generated.`,
          );
        }
        assertEquals(
          JSON.stringify(fpff), // comparing string to string since the file is large
          await fixtures.goldenText(f.comprehensive.projection),
        );
      },
    );

    await s.step(
      `validate stable mdast tree via 'inspect' output in ${
        ff.relToCWD(f.comprehensive.inspect)
      }`,
      async () => {
        // when required, use this to store stable "golden" version as a text file:
        if (generateGoldens) {
          await fixtures.goldenText(f.comprehensive.inspect, inspect(root));
          console.warn(
            `This test run is invalid since ${
              ff.relToCWD(f.comprehensive.inspect)
            } is being generated.`,
          );
        }
        assertEquals(
          inspect(root),
          await fixtures.goldenText(f.comprehensive.inspect),
        );
      },
    );

    await s.step(
      `validate stable graph edges via GraphViz dot in ${
        ff.relToCWD(f.comprehensive.graphDot)
      }`,
      async () => {
        // when required, use this to store stable "golden" version of the edge in GraphViz dot format
        if (generateGoldens) {
          await fixtures.goldenText(f.comprehensive.graphDot, graphToDot(gr));
          console.warn(
            `This test run is invalid since ${
              ff.relToCWD(f.comprehensive.graphDot)
            } is being generated.`,
          );
        }

        assertEquals(
          graphToDot(gr),
          await fixtures.goldenText(f.comprehensive.graphDot),
        );
      },
    );

    await s.step(
      `smoke test relations and headings from ${comprehensive.file.basename}`,
      () => {
        assertEquals(Array.from(gr.rels), [
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
          "isCodePartialCandidate",
          "isTask",
        ]);

        assertEquals(gr.relCounts, {
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
          isCodePartialCandidate: 2,
          sectionSemanticId: 34,
        });

        const geTree = graphEdgesTree(
          gr.edges as GraphEdge<"containedInSection">[],
          { relationships: ["containedInSection"] },
        );
        assertEquals(headingsTreeText(geTree, false), headingsTreeGolden);
      },
    );
  });

  await t.step(ff.relToCWD(fixtures.runbook1MdPath), () => {
    const [_, runbook1] = me;

    assert(runbook1);
    const { mdastRoot: root } = runbook1;
    const gr = graph(root);

    assertEquals(Array.from(gr.rels), [
      "isImportant",
      "isCode",
      "isSpawnableCodeCandidate",
      "codeDependsOn",
    ]);

    assertEquals(gr.relCounts, {
      isCode: 5,
      isSpawnableCodeCandidate: 5,
      isImportant: 1,
      codeDependsOn: 1,
    });
  });

  await t.step(ff.relToCWD(fixtures.runbook2MdPath), () => {
    const [_, _runbook1, runbook2] = me;

    assert(runbook2);
    const { mdastRoot: root } = runbook2;
    const gr = graph(root);

    assertEquals(Array.from(gr.rels), [
      "isCode",
      "isSpawnableCodeCandidate",
      "isCodePartialCandidate",
      "codeDependsOn",
    ]);

    assertEquals(gr.relCounts, {
      isCode: 5,
      isSpawnableCodeCandidate: 5,
      isCodePartialCandidate: 1,
      codeDependsOn: 1,
    });
  });

  await t.step(ff.relToCWD(fixtures.runbook3MdPath), () => {
    const [_, _runbook1, _runbook2, runbook3] = me;

    assert(runbook3);
    const { mdastRoot: root } = runbook3;
    const gr = graph(root);

    assertEquals(Array.from(gr.rels), [
      "isImportant",
      "isCode",
      "isSpawnableCodeCandidate",
    ]);

    assertEquals(gr.relCounts, {
      isImportant: 1,
      isCode: 18,
      isSpawnableCodeCandidate: 3,
    });
  });

  await t.step(ff.relToCWD(fixtures.runbook4MdPath), () => {
    const [_, _runbook1, _runbook2, _runbook3, runbook4] = me;

    assert(runbook4);
    const { mdastRoot: root } = runbook4;
    const gr = graph(root);

    assertEquals(Array.from(gr.rels), [
      "isCode",
      "isSpawnableCodeCandidate",
      "isTask",
    ]);

    assertEquals(gr.relCounts, {
      isCode: 6,
      isSpawnableCodeCandidate: 6,
      isTask: 6,
    });
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
