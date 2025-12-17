// flexible-pattern_test.ts
import { assert, assertEquals } from "@std/assert";
import { flexiblePatterns } from "./flexible-pattern.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("flexible-pattern (parse + test) ...", async (t) => {
  await t.step("parse: '*' => kind=all, matches everything", () => {
    const fp = flexiblePatterns();
    const pat = fp.parse("*");
    assertEquals(pat.kind, "all");
    assert(fp.test(pat, ""));
    assert(fp.test(pat, "sql"));
    assert(fp.test(pat, "anything at all"));
  });

  await t.step("parse: exact (defaultKind=exact) matches exactly", () => {
    const fp = flexiblePatterns({ defaultKind: "exact", trim: false });
    const pat = fp.parse("sql");
    assertEquals(pat.kind, "exact");
    assert(fp.test(pat, "sql"));
    assert(!fp.test(pat, "SQL"));
    assert(!fp.test(pat, " sql "));
  });

  await t.step("opts.trim: trims both pattern and value by default", () => {
    const fp = flexiblePatterns(); // trim default true
    const pat = fp.parse("  sql  ");
    assertEquals(pat.kind, "exact");
    assert(fp.test(pat, "sql"));
    assert(fp.test(pat, "  sql  "));
  });

  await t.step("opts.trim=false: preserves whitespace sensitivity", () => {
    const fp = flexiblePatterns({ trim: false });
    const pat = fp.parse("  sql  ");
    assertEquals(pat.kind, "exact");
    assert(fp.test(pat, "  sql  "));
    assert(!fp.test(pat, "sql"));
  });

  await t.step("parse: quoted exact forces exact interpretation", () => {
    const fp = flexiblePatterns({ defaultKind: "glob" });
    const pat = fp.parse('"*.sql"'); // quoted => exact literal "*.sql"
    assertEquals(pat.kind, "exact");
    assert(fp.test(pat, "*.sql"));
    assert(!fp.test(pat, "foo.sql"));
  });

  await t.step(
    "opts.allowQuotedExact=false disables quoted exact shortcut",
    () => {
      const fp = flexiblePatterns({
        defaultKind: "glob",
        allowQuotedExact: false,
      });
      const pat = fp.parse('"*.sql"'); // quotes treated literally
      assertEquals(pat.kind, "glob");
      assert(!fp.test(pat, "foo.sql"));
      assert(fp.test(pat, '"foo.sql"'));
    },
  );

  await t.step("parse: regex /.../ matches, and !/.../ negates", () => {
    const fp = flexiblePatterns();
    const re = fp.parse("/^sq.*/");
    assertEquals(re.kind, "re");
    assert(fp.test(re, "sql"));
    assert(fp.test(re, "sqlite"));
    assert(!fp.test(re, "ts"));

    const nre = fp.parse("!/^sq.*/");
    assertEquals(nre.kind, "re");
    assert(!fp.test(nre, "sql"));
    assert(fp.test(nre, "ts"));
  });

  await t.step(
    "opts.allowNegation=false: '!/re/' and '!glob' do NOT negate",
    () => {
      const fp = flexiblePatterns({
        allowNegation: false,
        defaultKind: "glob",
      });

      const pat1 = fp.parse("!/^sq.*/");
      assertEquals(pat1.kind, "glob");
      assert(!("negate" in pat1 && (pat1 as Any).negate === true));

      const pat2 = fp.parse("!*.sql");
      assertEquals(pat2.kind, "glob");
    },
  );

  await t.step("glob: defaultKind=glob supports glob patterns", () => {
    const fp = flexiblePatterns({ defaultKind: "glob" });

    const g1 = fp.parse("*.sql");
    assertEquals(g1.kind, "glob");
    assert(fp.test(g1, "foo.sql"));
    assert(fp.test(g1, "bar.sql"));
    assert(!fp.test(g1, "bar.txt"));
  });

  await t.step(
    "glob: preferExactWhenNoGlobMeta turns plain strings into exact",
    () => {
      const fp = flexiblePatterns({
        defaultKind: "glob",
        preferExactWhenNoGlobMeta: true,
      });

      const pat = fp.parse("foo.sql");
      assertEquals(pat.kind, "exact");
      assert(fp.test(pat, "foo.sql"));
      assert(!fp.test(pat, "bar.sql"));
    },
  );

  await t.step(
    "glob: preferExactWhenNoGlobMeta=false treats plain strings as glob",
    () => {
      const fp = flexiblePatterns({
        defaultKind: "glob",
        preferExactWhenNoGlobMeta: false,
      });

      const pat = fp.parse("foo.sql");
      assertEquals(pat.kind, "glob");
      assert(fp.test(pat, "foo.sql"));
      assert(!fp.test(pat, "bar.sql"));
    },
  );

  await t.step(
    "glob negation: '!*.sql' negates (when allowNegation=true)",
    () => {
      const fp = flexiblePatterns({ defaultKind: "glob", allowNegation: true });

      const pat = fp.parse("!*.sql");
      assertEquals(pat.kind, "glob");
      assert(!fp.test(pat, "foo.sql"));
      assert(fp.test(pat, "foo.txt"));
    },
  );

  await t.step("normalizeValue: allows case-insensitive matching", () => {
    const fp = flexiblePatterns({
      defaultKind: "exact",
      normalizeValue: (s) => s.toLowerCase(),
    });

    const pat = fp.parse("SQL");
    assertEquals(pat.kind, "exact");
    assert(fp.test(pat, "sql"));
    assert(fp.test(pat, "SQL"));
    assert(fp.test(pat, " sQl "));
  });

  await t.step("matches(): parse+test convenience works", () => {
    const fp = flexiblePatterns({ defaultKind: "glob" });
    assert(fp.matches("*.md", "readme.md"));
    assert(!fp.matches("*.md", "readme.txt"));
    assert(fp.matches("/^read.*/", "readme.md"));
    assert(fp.matches("!/^read.*/", "other.md"));
  });

  await t.step("toDebugString(): produces stable, useful strings", () => {
    const fp = flexiblePatterns({ defaultKind: "glob" });

    assertEquals(fp.toDebugString(fp.parse("*")), "*");

    const ex = fp.parse("sql");
    assertEquals(ex.kind, "exact");
    assert(fp.toDebugString(ex).startsWith('exact:"'));

    const re = fp.parse("/abc/");
    assertEquals(re.kind, "re");
    assertEquals(fp.toDebugString(re), "re:/abc/");

    const nre = fp.parse("!/abc/");
    assertEquals(nre.kind, "re");
    assertEquals(fp.toDebugString(nre), "not re:/abc/");

    const gl = fp.parse("*.sql");
    assertEquals(gl.kind, "glob");
    assert(fp.toDebugString(gl).startsWith("glob:/"));

    const ngl = fp.parse("!*.sql");
    assertEquals(ngl.kind, "glob");
    assert(fp.toDebugString(ngl).startsWith("not glob:/"));
  });

  await t.step(
    "empty string: becomes exact('') and matches empty after trim",
    () => {
      const fp = flexiblePatterns();
      const pat = fp.parse("");
      assertEquals(pat.kind, "exact");
      assert(fp.test(pat, ""));
      assert(fp.test(pat, "   "));
      assert(!fp.test(pat, "x"));
    },
  );

  /* ---------------------------------------------------------------------- */
  /* List helpers + prioritizedNegations                                      */
  /* ---------------------------------------------------------------------- */

  await t.step(
    "list helpers: testSome/testAll/testNone (default prioritizedNegations=true)",
    () => {
      const fp = flexiblePatterns({ defaultKind: "glob" });

      // includes a negation; correctness should hold regardless of order
      assert(fp.testSome(["*.sql", "!*.sql"], "foo.sql"));
      assert(fp.testSome(["*.sql", "!*.sql"], "foo.txt"));

      assert(fp.testAll(["!*.tmp", "*.sql"], "foo.sql"));
      assert(fp.testAll(["!*.tmp", "*.sql"], "foo.tmp") === false);

      assert(fp.testNone(["*.md", "*.txt"], "foo.sql"));
      assert(fp.testNone(["!*.sql"], "foo.txt") === false); // negation matches => not-none
    },
  );

  await t.step(
    "list helpers: prioritizedNegations can be disabled per call",
    () => {
      const fp = flexiblePatterns({ defaultKind: "glob" });

      // Same truth value, but exercises the option path.
      assert(
        fp.testSome(["!*.sql", "*.sql"], "foo.sql", {
          prioritizedNegations: false,
        }),
      );
      assert(
        fp.testSome(["!*.sql", "*.sql"], "foo.txt", {
          prioritizedNegations: false,
        }),
      );

      assert(
        fp.testAll(["!*.tmp", "*.sql"], "foo.sql", {
          prioritizedNegations: false,
        }),
      );
      assert(
        fp.testAll(["!*.tmp", "*.sql"], "foo.tmp", {
          prioritizedNegations: false,
        }) === false,
      );

      assert(
        fp.testNone(["*.md", "*.txt"], "foo.sql", {
          prioritizedNegations: false,
        }),
      );
    },
  );

  await t.step(
    "filterMatching(): preserves input order even when evaluating negations first",
    () => {
      const fp = flexiblePatterns({ defaultKind: "glob" });
      const pats = ["*.md", "!*.sql", "*.sql"] as const;

      const m1 = fp.filterMatching(pats, "foo.sql"); // matches: !*.sql is false, *.sql true
      assertEquals(m1, ["*.sql"]);

      const m2 = fp.filterMatching(pats, "foo.txt"); // matches: !*.sql true
      assertEquals(m2, ["!*.sql"]);
    },
  );

  await t.step(
    "hasMatchAll(): works with default prioritization and explicit opts",
    () => {
      const fp = flexiblePatterns({ defaultKind: "glob" });
      assert(fp.hasMatchAll(["*", "*.sql"]) === true);
      assert(fp.hasMatchAll(["*.sql"]) === false);
      assert(
        fp.hasMatchAll(["*", "*.sql"], { prioritizedNegations: false }) ===
          true,
      );
    },
  );

  /* ---------------------------------------------------------------------- */
  /* testAllowDeny                                                            */
  /* ---------------------------------------------------------------------- */

  await t.step("testAllowDeny(): deny first, allow optional", () => {
    const fp = flexiblePatterns({ defaultKind: "glob" });

    // If deny matches -> false
    assert(
      fp.testAllowDeny({ deny: ["*.tmp"], allow: ["*.sql"] }, "foo.tmp") ===
        false,
    );

    // deny does not match; allow matches -> true
    assert(
      fp.testAllowDeny(
        { deny: ["*.tmp"], allow: ["*.sql", "*.md"] },
        "foo.sql",
      ) === true,
    );

    // deny does not match; allow does not match -> false
    assert(
      fp.testAllowDeny(
        { deny: ["*.tmp"], allow: ["*.sql", "*.md"] },
        "foo.txt",
      ) === false,
    );

    // allow missing/empty => allow-all (unless denied)
    assert(fp.testAllowDeny({ deny: ["*.tmp"] }, "foo.sql") === true);
    assert(fp.testAllowDeny({ deny: ["*.tmp"] }, "foo.tmp") === false);
  });
});
