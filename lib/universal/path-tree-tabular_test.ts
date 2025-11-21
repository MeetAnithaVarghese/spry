/**
 * path-tree-tabular_test.ts
 *
 * Top-level tests for path-tree-tabular.ts and friends.
 * - forestToTabular
 * - forestToStatelessViews
 * - forestToStatefulViews
 *
 * Subtests cover edge-cases (empty input, single root, index handling, prefixes/suffixes).
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  forestToStatefulViews,
  forestToStatelessViews,
  forestToTabular,
} from "./path-tree-tabular.ts";
import { pathTree } from "./path-tree.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type P = `/${string}`; // branded-ish path for tests

interface FilePayload {
  path: P;
  title?: string;
}

function samplePayloads(): FilePayload[] {
  return [
    { path: "/index.sql", title: "Home" },
    { path: "/docs/index.sql", title: "Docs" },
    { path: "/docs/intro.sql", title: "Intro" },
    { path: "/docs/api/index.sql", title: "API" },
    { path: "/docs/api/ref.sql", title: "Ref" },
    { path: "/about/index.sql", title: "About" },
  ];
}

// Build a forest once per test case to keep intent explicit
async function buildForest(payloads: FilePayload[]) {
  return await pathTree<FilePayload, P>(payloads, {
    nodePath: (n) => n.path,
    // default options are fine; indexBasenames already include index.sql
  });
}

// ---------------------------------------------------------------------------
// forestToTabular
// ---------------------------------------------------------------------------

Deno.test("forestToTabular: basic flattening", async (t) => {
  const forest = await buildForest(samplePayloads());
  const tab = forestToTabular<FilePayload, P>(forest);

  await t.step("nodes include expected paths and parent links", () => {
    const byPath = new Map(tab.node.map((n) => [n.path, n]));
    assert(byPath.has("/docs" as P));
    assert(byPath.has("/docs/index.sql" as P));
    assertEquals(byPath.get("/docs/index.sql" as P)?.parent_path, "/docs" as P);
  });

  await t.step("payloads serialize with default JSON", () => {
    const intro = tab.payload.find((p) => p.path === "/docs/intro.sql");
    assert(intro);
    assertMatch(intro!.json, /"path":"\/docs\/intro.sql"/);
  });

  await t.step("edges come from forestToEdges and are non-empty", () => {
    assert(tab.edge.length > 0);
    // An edge from /docs to /docs/index.sql should exist via canonical route logic
    const hasDocsIndex = tab.edge.some((e) =>
      e.child.endsWith("docs/index.sql")
    );
    assert(hasDocsIndex);
  });

  await t.step("breadcrumbs are container-based and ordered from root", () => {
    const crumbsForDocs = tab.breadcrumb.filter((b) => b.path === "/docs");
    // Expected: ["/", "/docs"]
    const ordered = crumbsForDocs.sort((a, b) => a.depth - b.depth).map((b) =>
      b.crumb_path
    );
    assertEquals(ordered[0], "/" as P);
    assertEquals(ordered.at(-1), "/docs" as P);
  });
});

Deno.test("forestToTabular: empty input yields empty arrays", async () => {
  const forest = await buildForest([]);
  const tab = forestToTabular<FilePayload, P>(forest);
  assertEquals(tab.node.length, 0);
  assertEquals(tab.edge.length, 0);
  assertEquals(tab.payload.length, 0);
  assertEquals(tab.breadcrumb.length, 0);
});

Deno.test("forestToTabular: single root file still creates container crumb", async () => {
  const forest = await buildForest([{ path: "/index.sql" }]);
  const tab = forestToTabular<FilePayload, P>(forest);
  const crumbsForRoot = tab.breadcrumb.filter((b) => b.path === "/" as P);
  // Breadcrumb for root should exist with depth 0
  const d0 = crumbsForRoot.find((b) => b.depth === 0);
  assert(d0);
  assertEquals(d0!.crumb_path, "/" as P);
});

// ---------------------------------------------------------------------------
// forestToStatelessViews
// ---------------------------------------------------------------------------

Deno.test("forestToStatelessViews: emits DROP/CREATE and singular view names", async () => {
  const forest = await buildForest(samplePayloads());
  const sql =
    forestToStatelessViews<FilePayload, P>(forest, { viewPrefix: "nav_" }).sql;

  assertEquals(
    sql,
    `
DROP VIEW IF EXISTS nav_node;
CREATE VIEW nav_node AS
WITH t(path, parent_path, basename, virtual, is_index) AS (
  VALUES
  ('/about', NULL, 'about', 1, 0),
('/about/index.sql', '/about', 'index.sql', 0, 1),
('/docs', NULL, 'docs', 1, 0),
('/docs/api', '/docs', 'api', 1, 0),
('/docs/api/index.sql', '/docs/api', 'index.sql', 0, 1),
('/docs/api/ref.sql', '/docs/api', 'ref.sql', 0, 0),
('/docs/index.sql', '/docs', 'index.sql', 0, 1),
('/docs/intro.sql', '/docs', 'intro.sql', 0, 0),
('/index.sql', NULL, 'index.sql', 0, 1)
)
SELECT * FROM t;

DROP VIEW IF EXISTS nav_edge;
CREATE VIEW nav_edge AS
WITH t(parent, child) AS (
  VALUES
  ('index.sql', 'about/index.sql'),
('index.sql', 'docs/api/index.sql'),
('docs/api/index.sql', 'docs/api/ref.sql'),
('index.sql', 'docs/index.sql'),
('docs/index.sql', 'docs/intro.sql')
)
SELECT * FROM t;

DROP VIEW IF EXISTS nav_payload;
CREATE VIEW nav_payload AS
WITH t(path, ord, json) AS (
  VALUES
  ('/about/index.sql', 0, '{"path":"/about/index.sql","title":"About"}'),
('/docs/api/index.sql', 0, '{"path":"/docs/api/index.sql","title":"API"}'),
('/docs/api/ref.sql', 0, '{"path":"/docs/api/ref.sql","title":"Ref"}'),
('/docs/index.sql', 0, '{"path":"/docs/index.sql","title":"Docs"}'),
('/docs/intro.sql', 0, '{"path":"/docs/intro.sql","title":"Intro"}'),
('/index.sql', 0, '{"path":"/index.sql","title":"Home"}')
)
SELECT * FROM t;

DROP VIEW IF EXISTS nav_breadcrumb;
CREATE VIEW nav_breadcrumb AS
WITH t(path, depth, crumb_path, crumb_basename) AS (
  VALUES
  ('/', 0, '/', '/'),
('/docs', 0, '/', '/'),
('/docs', 1, '/docs', 'docs'),
('/docs/api', 0, '/docs', 'docs'),
('/docs/api', 1, '/docs/api', 'api'),
('/about', 0, '/', '/'),
('/about', 1, '/about', 'about')
)
SELECT * FROM t;

DROP VIEW IF EXISTS nav_child;
CREATE VIEW nav_child AS
SELECT p.path AS parent_path, c.path AS child_path, c.basename AS child_basename, c.virtual, c.is_index
FROM nav_node p
JOIN nav_node c ON c.parent_path = p.path;

DROP VIEW IF EXISTS nav_descendant;
CREATE VIEW nav_descendant AS
WITH RECURSIVE d(root_path, path, depth) AS (
  SELECT n.path AS root_path, n.path, 0 AS depth FROM nav_node n
  UNION ALL
  SELECT d.root_path, c.path, d.depth + 1
  FROM d
  JOIN nav_node c ON c.parent_path = d.path
)
SELECT * FROM d;\n`.trimStart(),
  );
});

// ---------------------------------------------------------------------------
// forestToStatefulViews
// ---------------------------------------------------------------------------

Deno.test("forestToStatefulViews: emits DROP/CREATE TABLEs and prefixed/suffixed names", async (t) => {
  const forest = await buildForest(samplePayloads());
  const { sections } = forestToStatefulViews<FilePayload, P>(forest, {
    tablePrefix: "nav_",
    tableSuffix: "_stateful",
    viewPrefix: "nav_",
  });

  await t.step("tables are singular and dropped then created", () => {
    assertMatch(sections.ddl, /DROP TABLE IF EXISTS nav_node_stateful;/);
    assertMatch(sections.ddl, /CREATE TABLE nav_node_stateful\(/);
    assertMatch(sections.ddl, /DROP TABLE IF EXISTS nav_edge_stateful;/);
    assertMatch(sections.ddl, /DROP TABLE IF EXISTS nav_payload_stateful;/);
    assertMatch(sections.ddl, /DROP TABLE IF EXISTS nav_breadcrumb_stateful;/);
  });

  await t.step("views are singular and depend on table prefix/suffix", () => {
    assertMatch(sections.views, /DROP VIEW IF EXISTS nav_child;/);
    assertMatch(
      sections.views,
      /FROM nav_node_stateful p\s+JOIN nav_node_stateful c ON/,
    );
    assertMatch(sections.views, /CREATE VIEW nav_descendant AS/);
    assertMatch(sections.views, /CREATE VIEW nav_edge AS/);
  });

  await t.step("DML inserts rows into table-suffixed names", () => {
    assertMatch(
      sections.dml,
      /INSERT INTO nav_node_stateful\(path, parent_path, basename, virtual, is_index\)/,
    );
    assertMatch(sections.dml, /INSERT INTO nav_edge_stateful\(parent, child\)/);
    assertMatch(
      sections.dml,
      /INSERT INTO nav_payload_stateful\(path, ord, json\)/,
    );
    assertMatch(
      sections.dml,
      /INSERT INTO nav_breadcrumb_stateful\(path, depth, crumb_path, crumb_basename\)/,
    );
  });
});
