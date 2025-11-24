import { assert, assertEquals, assertFalse } from "@std/assert";
import { remark } from "remark";
import remarkFrontmatter from "remark-frontmatter";
import type { Code, Heading, Paragraph, Root, RootContent } from "types/mdast";

import { documentFrontmatter } from "../doc/doc-frontmatter.ts";
import { classifiersFromFrontmatter } from "./node-classify-fm.ts";
import {
  catalogToRootData,
  type ClassifierCatalog,
  nodeClassifier,
  type NodeClassifierRule,
  nodeClassNDF,
} from "./node-classify.ts";

/**
 * Helper: parse markdown into an mdast Root using the full pipeline:
 * - remark-frontmatter (extract yaml node)
 * - documentFrontmatter (parse YAML → documentFrontmatter)
 * - nodeClassifier (apply classifications)
 */
async function parseMarkdown(
  md: string,
  options: Parameters<typeof nodeClassifier>[0],
): Promise<Root> {
  const processor = remark()
    .use(remarkFrontmatter, ["yaml"])
    .use(documentFrontmatter)
    .use(nodeClassifier, options as never);

  const tree = processor.parse(md) as Root;
  await processor.run(tree);
  return tree;
}

const SAMPLE_MD = `
# Title

Intro paragraph

## Section A

Paragraph A1

\`\`\`sql
select 1;
\`\`\`

## Section B

Paragraph B1

### Subsection B1

Paragraph B1.1
`.trim() + "\n";

const FRONTMATTER_MD = `
---
doc-classify:
  - select: heading[depth="1"]
    role: project
  - select: heading[depth="2"]
    role: test-strategy
  - select: heading[depth="3"]
    role: test-plan
  - select: heading[depth="4"]
    role: test-case
---
# Project Title
## Strategy Heading
### Plan Heading
#### Case Heading
`.trim() + "\n";

const FRONTMATTER_BAGGAGE_MD = `
---
doc-classify:
  - select: heading[depth="1"]
    role:
      path: project
      baggage:
        id: proj-123
        severity: high
---
# Project With Baggage
`.trim() + "\n";

Deno.test("nodeClassifier remark plugin", async (t) => {
  await t.step(
    "classifies nodes and builds catalog via callback stored on root.data",
    async () => {
      let catalogSeen: ClassifierCatalog | undefined;

      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (_root: Root) => [
          // Mark the main title
          {
            nodes: [`heading[depth="1"]`],
            classify: (nodes) => {
              assertEquals(nodes.length, 1);
              return { namespace: "role", path: "title" };
            },
          },
          // Mark all h2 headings as sections
          {
            nodes: [`heading[depth="2"]`],
            classify: () => ({ namespace: "role", path: "section" }),
          },
          // Mark all paragraphs as "body"
          {
            nodes: ["paragraph"],
            classify: (nodes) =>
              nodes.length > 0 ? { namespace: "kind", path: "body" } : false,
          },
          // Mark SQL code blocks with two tags to exercise array merging
          {
            nodes: ["code[lang=sql]"],
            classify: () => ({
              namespace: "tag",
              path: ["sql", "example"],
            }),
          },
          // Second classifier for the same SQL code on the same key (merge)
          {
            nodes: ["code[lang=sql]"],
            classify: () => ({ namespace: "tag", path: "snippet" }),
          },
        ],
        // store the catalog on root.data.classifierCatalog like the old behavior.
        catalog: (catalog, root) => {
          catalogSeen = catalog;

          const anyRoot = root as Root & {
            data?: Record<string, unknown> & {
              classifierCatalog?: ClassifierCatalog;
            };
          };
          if (!anyRoot.data) anyRoot.data = {};
          anyRoot.data.classifierCatalog = catalog;
        },
      });

      const children = root.children;

      const h1 = children.find(
        (n): n is Heading => n.type === "heading" && (n as Heading).depth === 1,
      );
      const pIntro = children.find(
        (n): n is Paragraph => n.type === "paragraph",
      );
      const h2A = children.find(
        (n): n is Heading => n.type === "heading" && (n as Heading).depth === 2,
      );
      const sqlCode = children.find(
        (n): n is Code => n.type === "code" && (n as Code).lang === "sql",
      );

      assert(h1);
      assertEquals(h1.type, "heading");
      assertEquals(h1.depth, 1);

      assert(pIntro);
      assertEquals(pIntro.type, "paragraph");

      assert(h2A);
      assertEquals(h2A.type, "heading");
      assertEquals(h2A.depth, 2);

      assert(sqlCode);
      assertEquals(sqlCode.type, "code");
      assertEquals(sqlCode.lang, "sql");

      // h1 classification
      assert(nodeClassNDF.is(h1));
      const h1Role = h1.data!.class["role"] ?? [];
      const h1RolePaths = h1Role.map((c) => c.path).sort();
      assertEquals(h1RolePaths, ["title"]);

      // h2 classification
      assert(nodeClassNDF.is(h2A));
      const h2Role = h2A.data!.class["role"] ?? [];
      const h2RolePaths = h2Role.map((c) => c.path).sort();
      assertEquals(h2RolePaths, ["section"]);

      // paragraph classification (at least intro paragraph)
      assert(nodeClassNDF.is(pIntro));
      const introKind = pIntro.data!.class["kind"] ?? [];
      const introKindPaths = introKind.map((c) => c.path).sort();
      assertEquals(introKindPaths, ["body"]);

      // SQL code: ensure merging of multiple classifications on same key
      assert(nodeClassNDF.is(sqlCode));
      const tagClasses = sqlCode.data!.class["tag"] ?? [];
      const tagPaths = tagClasses.map((c) => c.path).sort();
      assertEquals(tagPaths, ["example", "snippet", "sql"].sort());

      // Catalog callback should have received a populated catalog.
      assert(catalogSeen);
      const catalog = catalogSeen!;

      // And we also stored it on root.data.classifierCatalog via the callback.
      const anyRoot = root as Root & {
        data?: {
          classifierCatalog?: ClassifierCatalog;
        };
      };
      assert(anyRoot.data && anyRoot.data.classifierCatalog);
      const storedCatalog = anyRoot.data.classifierCatalog!;
      assertEquals(storedCatalog, catalog);

      // Catalog should include entries for role + kind + tag
      assert("role" in catalog);
      assert("kind" in catalog);
      assert("tag" in catalog);

      // Verify that catalog.role.title contains the h1
      const roleTitle = catalog.role["title"] ?? [];
      assert(roleTitle.length >= 1);
      assert(roleTitle.includes(h1));

      // Verify that catalog.role.section contains at least one h2
      const roleSection = catalog.role["section"] ?? [];
      assert(roleSection.length >= 1);
      assert(roleSection.includes(h2A));

      // Verify that catalog.tag has "sql", "example", "snippet"
      const tagSql = catalog.tag["sql"] ?? [];
      const tagExample = catalog.tag["example"] ?? [];
      const tagSnippet = catalog.tag["snippet"] ?? [];
      assert(tagSql.includes(sqlCode));
      assert(tagExample.includes(sqlCode));
      assert(tagSnippet.includes(sqlCode));
    },
  );

  await t.step(
    "does not create or store catalog when catalog callback is omitted",
    async () => {
      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (_root: Root) => [
          {
            nodes: [`heading[depth="1"]`],
            classify: () => ({ namespace: "role", path: "title" }),
          },
        ],
        // no catalog callback
      });

      const h1 = root.children[0] as RootContent;
      assert(h1.type === "heading");

      // Node still gets classification
      assert(nodeClassNDF.is(h1));
      const roleClasses = h1.data.class["role"] ?? [];
      const rolePaths = roleClasses.map((c) => c.path).sort();
      assertEquals(rolePaths, ["title"]);

      // But root has no classifierCatalog (we never set it)
      const anyRoot = root as Root & { data?: Record<string, unknown> };
      assertFalse(
        !!anyRoot.data && "classifierCatalog" in (anyRoot.data as Record<
              string,
              unknown
            >),
      );
    },
  );

  await t.step(
    "catalog callback is invoked with empty catalog when there are no classifiers",
    async () => {
      let catalogSeen: ClassifierCatalog | undefined;

      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (_root: Root) => [], // no rules
        catalog: (catalog, _root) => {
          catalogSeen = catalog;
        },
      });

      // Root should be untouched except for normal remark behavior.
      assert(root.children.length > 0);

      // We still build an empty catalog and invoke the callback.
      assert(catalogSeen);
      assertEquals(Object.keys(catalogSeen!).length, 0);
    },
  );

  await t.step(
    "catalog callback receives empty catalog when classifier returns false",
    async () => {
      let catalogSeen: ClassifierCatalog | undefined;

      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (_root: Root) => [
          {
            nodes: ["paragraph"],
            classify: (nodes) => {
              // simulate early exit: skip applying any class
              if (nodes.length > 0) return false;
              return { namespace: "kind", path: "body" };
            },
          },
        ],
        catalog: (catalog, _root) => {
          catalogSeen = catalog;
        },
      });

      const paragraphs = root.children.filter(
        (n) => n.type === "paragraph",
      ) as RootContent[];

      assert(paragraphs.length > 0);
      for (const p of paragraphs) {
        assertFalse(nodeClassNDF.is(p));
      }

      // Catalog callback should have been invoked with an empty catalog.
      assert(catalogSeen);
      assertEquals(Object.keys(catalogSeen!).length, 0);
    },
  );

  await t.step(
    "hasNodeClass returns false for unclassified nodes",
    async () => {
      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (_root: Root) => [
          {
            nodes: [`heading[depth="1"]`],
            classify: () => ({ namespace: "role", path: "title" }),
          },
        ],
        // no catalog needed here
      });

      const h1 = root.children[0] as RootContent;
      const someParagraph = root.children.find(
        (n) => n.type === "paragraph",
      ) as RootContent | undefined;

      assert(h1.type === "heading");
      assert(someParagraph && someParagraph.type === "paragraph");

      assert(nodeClassNDF.is(h1)); // classified
      assertFalse(nodeClassNDF.is(someParagraph)); // not classified
    },
  );

  await t.step(
    "supports generator-based classifiers (Iterable, not just arrays)",
    async () => {
      function* generatorClassifiers(
        _root: Root,
      ): IterableIterator<NodeClassifierRule> {
        // yield one simple rule for h1
        yield {
          nodes: [`heading[depth="1"]`],
          classify: (nodes) => ({
            namespace: "role",
            path: nodes.length === 1 ? "title" : "heading",
          }),
        };
      }

      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (root: Root) => generatorClassifiers(root),
        catalog: catalogToRootData("classifierCatalogViaHelper"),
      });

      const h1 = root.children.find(
        (n) => n.type === "heading",
      ) as RootContent | undefined;

      assert(h1);
      assert(nodeClassNDF.is(h1));
      const roles = h1.data.class["role"] ?? [];
      const rolePaths = roles.map((c) => c.path).sort();
      assertEquals(rolePaths, ["title"]);

      // Using catalogToRootData helper, catalog is stored on root.data
      const anyRoot = root as Root & {
        data?: {
          classifierCatalogViaHelper?: ClassifierCatalog;
        };
      };
      const catalog = anyRoot.data?.classifierCatalogViaHelper;
      assert(catalog);

      // Catalog should reflect the generator rule
      const titles = catalog!.role?.["title"] ?? [];
      assert(titles.includes(h1));
    },
  );

  await t.step(
    "classify can return an Iterator to apply multiple classifications",
    async () => {
      let catalogSeen: ClassifierCatalog | undefined;

      const root = await parseMarkdown(SAMPLE_MD, {
        classifiers: (_root: Root) => [
          {
            nodes: [`heading[depth="1"]`],
            classify: (_nodes) => {
              // Multiple class entries for the same selection
              function* entries() {
                yield { namespace: "role", path: "title" as const };
                yield { namespace: "kind", path: "heading" as const };
              }
              return entries();
            },
          },
        ],
        catalog: (catalog, _root) => {
          catalogSeen = catalog;
        },
      });

      const h1 = root.children.find(
        (n) => n.type === "heading",
      ) as RootContent | undefined;

      assert(h1);
      assert(nodeClassNDF.is(h1));

      const roleClasses = h1.data.class["role"] ?? [];
      const kindClasses = h1.data.class["kind"] ?? [];
      const rolePaths = roleClasses.map((c) => c.path).sort();
      const kindPaths = kindClasses.map((c) => c.path).sort();

      assertEquals(rolePaths, ["title"]);
      assertEquals(kindPaths, ["heading"]);

      // Catalog should have both keys and include the h1 under both.
      assert(catalogSeen);
      const catalog = catalogSeen!;
      const roleTitle = catalog.role?.["title"] ?? [];
      const kindHeading = catalog.kind?.["heading"] ?? [];
      assert(roleTitle.includes(h1));
      assert(kindHeading.includes(h1));
    },
  );

  await t.step(
    "builds classifiers from document frontmatter DSL via classifiersFromFrontmatter",
    async () => {
      const root = await parseMarkdown(FRONTMATTER_MD, {
        classifiers: classifiersFromFrontmatter(), // default key = "doc-classify"
        catalog: catalogToRootData("classifierCatalogFromFM"),
      });

      const children = root.children;

      const h1 = children.find(
        (n): n is Heading => n.type === "heading" && (n as Heading).depth === 1,
      );
      const h2 = children.find(
        (n): n is Heading => n.type === "heading" && (n as Heading).depth === 2,
      );
      const h3 = children.find(
        (n): n is Heading => n.type === "heading" && (n as Heading).depth === 3,
      );
      const h4 = children.find(
        (n): n is Heading => n.type === "heading" && (n as Heading).depth === 4,
      );

      assert(h1 && h2 && h3 && h4);

      assert(nodeClassNDF.is(h1));
      assertEquals(
        (h1.data.class["role"] ?? []).map((c) => c.path),
        ["project"],
      );

      assert(nodeClassNDF.is(h2));
      assertEquals(
        (h2.data.class["role"] ?? []).map((c) => c.path),
        ["test-strategy"],
      );

      assert(nodeClassNDF.is(h3));
      assertEquals(
        (h3.data.class["role"] ?? []).map((c) => c.path),
        ["test-plan"],
      );

      assert(nodeClassNDF.is(h4));
      assertEquals(
        (h4.data.class["role"] ?? []).map((c) => c.path),
        ["test-case"],
      );

      // Catalog should show all these roles too via catalogToRootData
      const anyRoot = root as Root & {
        data?: { classifierCatalogFromFM?: ClassifierCatalog };
      };
      const catalog = anyRoot.data?.classifierCatalogFromFM;
      assert(catalog);

      const proj = catalog.role?.["project"] ?? [];
      const strat = catalog.role?.["test-strategy"] ?? [];
      const plan = catalog.role?.["test-plan"] ?? [];
      const tcase = catalog.role?.["test-case"] ?? [];

      assert(proj.includes(h1));
      assert(strat.includes(h2));
      assert(plan.includes(h3));
      assert(tcase.includes(h4));
    },
  );

  await t.step(
    "supports baggage on classifications from rules",
    async () => {
      const root = await parseMarkdown("# Title\n", {
        classifiers: (_root: Root) => [
          {
            nodes: [`heading[depth="1"]`],
            classify: () => ({
              namespace: "role",
              path: "project",
              baggage: { id: "proj-1", severity: "high" },
            }),
          },
        ],
      });

      const h1 = root.children.find(
        (n) => n.type === "heading",
      ) as Heading | undefined;
      assert(h1);
      assert(nodeClassNDF.is(h1));

      const roleClasses = h1.data.class["role"] ?? [];
      assertEquals(roleClasses.length, 1);
      assertEquals(roleClasses[0].path, "project");
      assertEquals(roleClasses[0].baggage, {
        id: "proj-1",
        severity: "high",
      });
    },
  );

  await t.step(
    "supports baggage on classifications from document frontmatter",
    async () => {
      const root = await parseMarkdown(FRONTMATTER_BAGGAGE_MD, {
        classifiers: classifiersFromFrontmatter(),
      });

      const h1 = root.children.find(
        (n) => n.type === "heading",
      ) as Heading | undefined;
      assert(h1);
      assert(nodeClassNDF.is(h1));

      const roleClasses = h1.data.class["role"] ?? [];
      assertEquals(roleClasses.length, 1);
      assertEquals(roleClasses[0].path, "project");
      assertEquals(roleClasses[0].baggage, {
        id: "proj-123",
        severity: "high",
      });
    },
  );
});
