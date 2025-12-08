import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { sqlCat, sqlRaw } from "../../universal/sql-text.ts";
import { breadcrumbs, markdownLinkFactory } from "./interpolate.ts";

Deno.test("markdownLinkFactory — basics", async (t) => {
  await t.step(
    "default base: base unencoded; ONLY non-literal url parts encoded",
    () => {
      const md = markdownLinkFactory({ url_encode: "sqlpage" }); // base = COALESCE(SQLPAGE_SITE_PREFIX, '') (unencoded)
      const text = sqlCat`${"label"}`; // → label
      const url = sqlCat`/details?id=${"id"}`; // → ('/details?id=' || id)

      const got = md.link(text, url);
      const expect = "('[' || label || '](' || " +
        "COALESCE(sqlpage.environment_variable('SQLPAGE_SITE_PREFIX'), '') || " +
        "'/details?id=' || sqlpage.url_encode(id) || ')')";

      assertEquals(got, expect);
    },
  );

  await t.step(
    "custom factory base applies to all calls (base unencoded)",
    () => {
      const md = markdownLinkFactory({
        base: sqlRaw`'https://example.org'`,
        url_encode: "sqlpage",
      });
      const got = md.link(sqlCat`${"name"}`, sqlCat`/p/${"id"}`);
      const expect =
        "('[' || name || '](' || 'https://example.org' || '/p/' || sqlpage.url_encode(id) || ')')";
      assertEquals(got, expect);
    },
  );

  await t.step("per-call base override: skip base entirely", () => {
    const md = markdownLinkFactory({
      base: sqlRaw`'https://x.com'`,
      url_encode: "sqlpage",
    });
    const got = md.link(sqlCat`${"label"}`, sqlCat`/y?id=${"id"}`, {
      base: false,
    });
    const expect =
      "('[' || label || '](' || '/y?id=' || sqlpage.url_encode(id) || ')')";
    assertEquals(got, expect);
  });

  await t.step(
    "idempotent per-part encoding: already-encoded or literal segments pass through",
    () => {
      const md = markdownLinkFactory({
        base: sqlRaw`'https://e.org'`,
        url_encode: "sqlpage",
      });
      const text = sqlCat`${"title"}`;
      // '/x/' is a literal -> not encoded; id is non-literal -> encoded.
      // The inner sqlpage.url_encode(id) is already encoded -> pass-through.
      const url = sqlRaw`'/x/' || ${sqlRaw`${"id"}`}`;
      const got = md.link(text, url);
      const expect =
        "('[' || title || '](' || 'https://e.org' || '/x/' || sqlpage.url_encode(id) || ')')";
      assertEquals(got, expect);
    },
  );

  await t.step("cat(): alias of sqlCat for ergonomic expressions", () => {
    const md = markdownLinkFactory();
    const u = md.cat`/z/${"id"}`; // same as sqlCat`/z/${"id"}`
    assertEquals(u, "('/z/' || id)");
  });

  await t.step(
    "encodeEachNonLiteral(): splits on top-level || and encodes only non-literals",
    () => {
      const md = markdownLinkFactory({ url_encode: "replace" });
      const expr = sqlCat`/a/${"x"}?q=${"y"}`; // -> ('/a/' || x || '?q=' || y)
      const mapped = md.encodeEachNonLiteral(expr);
      // '/a/' and '?q=' are literals -> not encoded. x and y are identifiers -> encoded.
      assertEquals(
        mapped,
        "'/a/' || replace(replace(replace(x, ' ', '%20'), '&', '%26'), '#', '%23') || '?q=' || replace(replace(replace(y, ' ', '%20'), '&', '%26'), '#', '%23')",
      );
    },
  );

  await t.step("splitTopLevelConcat(): respects quotes and parentheses", () => {
    const md = markdownLinkFactory();
    const expr = "('/a''b/' || (coalesce(x, '')) || 'q=' || y)";
    const parts = md.splitTopLevelConcat(expr);
    assertEquals(parts, ["'/a''b/'", "(coalesce(x, ''))", "'q='", "y"]);
  });

  await t.step("mdLink() with array-ish fragments via cat/sqlRaw", () => {
    const md = markdownLinkFactory({
      base: sqlRaw`'https://ex.org'`,
      url_encode: "sqlpage",
    });
    const text = [sqlRaw`${"first"}`, sqlRaw`' '`, sqlRaw`${"last"}`]; // → first || ' ' || last
    const url = md.cat`/p?id=${"pid"}&d=${"dept"}`;
    const got = md.link(text, url);
    const expect =
      "('[' || first || ' ' || last || '](' || 'https://ex.org' || " +
      "'/p?id=' || sqlpage.url_encode(pid) || '&d=' || sqlpage.url_encode(dept) || ')')";
    assertEquals(got, expect);
  });
});

Deno.test("breadcrumbs — JSON-based breadcrumbs", async (t) => {
  await t.step("generates SQL that reads from breadcrumbs.auto.json", () => {
    const sql = breadcrumbs("scf/controls.sql", "Controls Library");

    // Should read from JSON file first (SET statement before SELECT)
    assertStringIncludes(
      sql,
      "SET breadcrumbs_json = sqlpage.read_file_as_text('spry.d/auto/route/breadcrumbs.auto.json')",
    );

    // Should include breadcrumb component
    assertStringIncludes(sql, "SELECT 'breadcrumb' AS component");

    // Should include Home breadcrumb
    assertStringIncludes(sql, "'Home' as title");
    assertStringIncludes(sql, "'/' as link");

    // Should extract breadcrumb trail using json_each with concatenated path
    assertStringIncludes(
      sql,
      "json_each(json_extract($breadcrumbs_json, '$.' || scf/controls.sql))",
    );

    // Should include current page breadcrumb with title (no quotes around variable)
    assertStringIncludes(sql, "Controls Library as title");

    // Current page should have '#' as link
    assertStringIncludes(sql, "'#' as link");

    // Should filter out 'home' title (case-insensitive)
    assertStringIncludes(sql, "WHERE LOWER(Controls Library) <> 'home'");
  });

  await t.step("escapes SQL special characters in path and title", () => {
    const sql = breadcrumbs("path/with'quote.sql", "Title with 'quotes'");

    // Single quotes should be escaped (doubled)
    assertStringIncludes(sql, "path/with''quote.sql");
    assertStringIncludes(sql, "Title with ''quotes''");
  });

  await t.step("filters out 'Home' title in current page breadcrumb", () => {
    const sql = breadcrumbs("/", "Home");

    // Should have WHERE clause to exclude 'home' (case-insensitive)
    assertStringIncludes(sql, "WHERE LOWER(Home) <> 'home'");

    // This means "Home" title will be filtered out
  });

  await t.step(
    "current page breadcrumb uses '#' as link instead of actual path",
    () => {
      const sql = breadcrumbs("some/path.sql", "Page Title");

      // Current page should use '#' as link (not the actual path)
      assertStringIncludes(sql, "'#' as link");

      // Should not include url_encode in the current page breadcrumb section
      const currentPageSection = sql.split("-- Current page breadcrumb")[1];
      assertEquals(currentPageSection?.includes("sqlpage.url_encode"), false);
    },
  );

  await t.step(
    "uses COALESCE for title priority: abbreviated > caption > computed",
    () => {
      const sql = breadcrumbs("some/path.sql", "Page Title");

      // Should prioritize abbreviated_caption, then caption, then computed from basename
      assertStringIncludes(sql, "COALESCE");
      assertStringIncludes(sql, "abbreviated_caption");
      assertStringIncludes(sql, "caption");
      assertStringIncludes(sql, "REPLACE(basename, '.sql', '')");
    },
  );

  await t.step(
    "JSON path uses concatenation instead of string interpolation",
    () => {
      const sql = breadcrumbs("test/page.sql", "Test Page");

      // Should use '$.' || path instead of '$."path"'
      assertStringIncludes(sql, "'$.' || test/page.sql");

      // Should not have quotes around the path in JSON extract
      assertEquals(sql.includes('$."test/page.sql"'), false);
    },
  );
});
