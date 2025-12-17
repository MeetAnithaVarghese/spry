// code-frontmatter_test.ts
import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { remark } from "remark";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { Code } from "types/mdast";
import { ensureLanguageByIdOrAlias } from "../../universal/code.ts";
import { instructionsFromText } from "../../universal/posix-pi.ts";
import {
  codeFrontmatter,
  type CodeFrontmatterOptions,
  type CodeFrontmatterPresetRule,
  presetsFactory,
} from "./code-frontmatter.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function pipeline() {
  // remark is only used to build an mdast tree; enrichment is done by
  // codeFrontmatter(), not a remark plugin.
  return remark().use(remarkGfm).use(remarkFrontmatter, ["yaml"]);
}

function codeNodes(tree: Any): Code[] {
  const out: Code[] = [];
  const walk = (n: Any) => {
    if (n.type === "code") out.push(n as Code);
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

function enrichFirstCode(
  md: string,
  opts: CodeFrontmatterOptions = { coerceNumbers: true },
) {
  const p = pipeline();
  const tree = p.parse(md);
  const node = codeNodes(tree)[0];
  assert(node, "Expected at least one code node");
  const fm = codeFrontmatter(node, opts);
  assert(fm, "Expected frontmatter to be parsed");
  return { node, fm: fm! };
}

function presetRule(
  metaLabel: string,
  presetInfo: string,
  match: (code: Code) => boolean,
  instrOpts: Parameters<typeof instructionsFromText>[1] = {
    coerceNumbers: true,
  },
): CodeFrontmatterPresetRule {
  return {
    meta: metaLabel,
    codeFM: instructionsFromText(presetInfo, instrOpts),
    match,
  };
}

Deno.test("CodeFrontmatter enrichment ...", async (t) => {
  await t.step("basic: bare tokens and boolean flags", () => {
    const md = "```bash first -x --flag\ncode\n```";
    const { node, fm } = enrichFirstCode(md);

    // verify the data-bag is actually attached via caching
    const cached = (node as Any).data?.codeFM;
    assert(cached, "Expected codeFM to be cached on node.data");

    assertEquals(fm.lang, "bash");
    assertEquals(
      fm.langSpec?.id,
      ensureLanguageByIdOrAlias("bash").id,
    );
    assertEquals(fm.pi.pos, ["first", "x", "flag"]);
    // flags normalized with both bare and boolean forms
    assertEquals(fm.pi.flags.first, true);
    assertEquals(fm.pi.flags.x, true);
    assertEquals(fm.pi.flags.flag, true);

    // new field (no presets)
    assertEquals(fm.fromPresets.length, 0);
  });

  await t.step(
    "flags with =value and two-token form merge into arrays and pos includes normalized keys",
    () => {
      const md = "```ts --tag=alpha --tag beta -L 9 key=value\ncode\n```";
      const { fm } = enrichFirstCode(md);

      assertEquals(fm.langSpec?.id, "typescript");
      assertEquals(fm.pi.pos, ["tag", "tag", "L", "key"]);
      assertEquals(fm.pi.flags.tag, ["alpha", "beta"]);
      assertEquals(fm.pi.flags.L, 9 as Any);
      assertEquals(fm.pi.flags.key, "value");
      assertEquals(fm.fromPresets.length, 0);
    },
  );

  await t.step("ATTRS JSON parsed and exposed", () => {
    const md =
      "```json5 --x {priority: 5, env: 'qa', note: 'hello', list: [1,2,3]}\n{}\n```";
    const { fm } = enrichFirstCode(md);

    assertEquals(fm.lang, "json5");
    assertEquals(fm.langSpec?.id, "json5");
    assertEquals(fm.attrs?.priority, 5);
    assertEquals(fm.attrs?.env, "qa");
    assertEquals(fm.attrs?.note, "hello");
    assertEquals(fm.attrs?.list, [1, 2, 3]);
    assertEquals(fm.fromPresets.length, 0);
  });

  await t.step("normalizeFlagKey override maps aliases", () => {
    const md = "```py --ENV=prod -e qa stage\nprint('x')\n```";

    const opts: CodeFrontmatterOptions = {
      coerceNumbers: true,
      normalizeFlagKey: (k) => k.toLowerCase(),
    };

    const p = pipeline();
    const tree = p.parse(md);
    const node = codeNodes(tree)[0];
    assert(node);

    const fm = codeFrontmatter(node, opts);
    assert(fm);

    // all keys normalized to lower-case
    assertEquals(fm.langSpec?.id, "python");
    assertEquals(fm.pi.pos, ["env", "e", "stage"]);
    assertEquals(fm.pi.flags.env, "prod");
    assertEquals(fm.pi.flags.e, "qa");
    assertEquals(fm.pi.flags.stage, true);
    assertEquals(fm.fromPresets.length, 0);
  });

  await t.step(
    "invalid JSON attrs ignored by default, and 'throw' option propagates",
    () => {
      // Make it invalid for JSON5 too: double comma -> syntax error
      const invalid = "```ts --x {bad: 1,,}\ncode\n```";

      // default: ignore (no explicit onAttrsParseError)
      {
        const p = pipeline();
        const tree = p.parse(invalid);
        const node = codeNodes(tree)[0];
        assert(node);

        const fm = codeFrontmatter(node, {
          coerceNumbers: true,
          // onAttrsParseError left as default ("ignore")
        });
        assert(fm);
        // ignored on error -> attrs should be empty-ish
        assertEquals(fm!.attrs ?? {}, {});
      }

      // 'throw': parse error should propagate from instructionsFromText / JSON5
      assertThrows(() => {
        const p = pipeline();
        const tree = p.parse(invalid);
        const node = codeNodes(tree)[0];
        assert(node);

        codeFrontmatter(node, {
          coerceNumbers: true,
          onAttrsParseError: "throw",
        });
      });
    },
  );

  await t.step(
    "idempotent (calling codeFrontmatter twice does not duplicate or change data)",
    () => {
      const md = "```ts a b c {x:1}\ncode\n```";
      const p = pipeline();
      const tree = p.parse(md);
      const node = codeNodes(tree)[0];
      assert(node);

      const fm1 = codeFrontmatter(node, { coerceNumbers: true });
      const fm2 = codeFrontmatter(node, { coerceNumbers: true });

      assert(fm1);
      assert(fm2);

      // Same object returned due to caching
      assertStrictEquals(fm1, fm2);

      const data = (node as Any).data;
      assert(data, "Expected data bag on node");
      const fmFromBag = data.codeFM;
      assert(fmFromBag, "Expected codeFM cached in data bag");

      // Data-bag is stable and matches parsed result
      assertStrictEquals(fmFromBag, fm1);
      assertEquals(fmFromBag.lang, fm1.lang);
      assertEquals(fmFromBag.pi.pos, fm1.pi.pos);
      assertEquals(fmFromBag.attrs?.x, 1);
    },
  );

  await t.step(
    "public helper codeFrontmatter() parses from a raw Code node",
    () => {
      const md = "```sql --stage prod {sharded: true}\nSELECT 1;\n```";
      const p = pipeline();
      const tree = p.parse(md);
      const node = codeNodes(tree)[0];
      assert(node);

      const parsed = codeFrontmatter(node, {
        coerceNumbers: true,
      });
      assert(parsed);
      assertEquals(parsed?.lang, "sql");
      assertEquals(parsed?.pi.flags.stage, "prod");
      assertEquals(parsed?.attrs?.sharded, true);
      assertEquals(parsed?.fromPresets.length, 0);
    },
  );

  await t.step(
    "mixed: bare tokens recorded in pos and as booleans",
    () => {
      const md = "```txt alpha beta -x --y\n...\n```";
      const { fm } = enrichFirstCode(md);

      assertEquals(fm.pi.pos, ["alpha", "beta", "x", "y"]);
      assertEquals(fm.pi.flags.alpha, true);
      assertEquals(fm.pi.flags.beta, true);
      assertEquals(fm.pi.flags.x, true);
      assertEquals(fm.pi.flags.y, true);
      assertEquals(fm.fromPresets.length, 0);
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Presets                                                                 */
  /* ---------------------------------------------------------------------- */

  await t.step("presets: applied rules are recorded in fromPresets", () => {
    const md = "```sql --tag x\nSELECT 1;\n```";
    const p = pipeline();
    const tree = p.parse(md);
    const node = codeNodes(tree)[0];
    assert(node);

    const presets = [
      presetRule(
        "sql defaults A",
        "preset --stage prod { sharded: true }",
        (c) => c.lang === "sql",
      ),
      presetRule(
        "never matches",
        "preset --nope true { nope: true }",
        (c) => c.lang === "nope",
      ),
    ] as const;

    const fm = codeFrontmatter(node, {
      coerceNumbers: true,
      presets,
      // Keep cache on: this is the normal mode.
    });
    assert(fm);

    assertEquals(fm.fromPresets.length, 1);
    assertEquals(fm.fromPresets[0].meta, "sql defaults A");

    // defaults flags applied (posix-pi decides merge policy; default is fill-missing)
    assertEquals(fm.pi.flags.stage, "prod");

    // by default, attrs are NOT returned when only defaults exist
    assertEquals(fm.attrs, undefined);
  });

  await t.step(
    "presets: returnAttrsWhenDefaulted=true returns attrs even without attrsText",
    () => {
      const md = "```sql --tag x\nSELECT 1;\n```";
      const p = pipeline();
      const tree = p.parse(md);
      const node = codeNodes(tree)[0];
      assert(node);

      const presets = [
        presetRule(
          "sql attrs default",
          "preset { sharded: true, nested: { a: 1 } }",
          (c) => c.lang === "sql",
        ),
      ] as const;

      const fm = codeFrontmatter(node, {
        coerceNumbers: true,
        presets,
        defaults: {
          returnAttrsWhenDefaulted: true,
        },
      });
      assert(fm);

      assertEquals(fm.fromPresets.length, 1);
      assert(fm.attrs);
      assertEquals(fm.attrs.sharded, true);
      assertEquals((fm.attrs.nested as Any).a, 1);
    },
  );

  await t.step(
    "presets: parsed attrs override defaults under fill-missing policy",
    () => {
      const md =
        "```sql --tag x { sharded: false, nested: { b: 2 } }\nSELECT 1;\n```";
      const p = pipeline();
      const tree = p.parse(md);
      const node = codeNodes(tree)[0];
      assert(node);

      const presets = [
        presetRule(
          "sql attrs default",
          "preset { sharded: true, nested: { a: 1 } }",
          (c) => c.lang === "sql",
        ),
      ] as const;

      const fm = codeFrontmatter(node, {
        coerceNumbers: true,
        presets,
        defaults: {
          // default attrsPolicy is expected to let parsed override defaults
          returnAttrsWhenDefaulted: true,
        },
      });
      assert(fm);

      assert(fm.attrs);
      assertEquals(fm.attrs.sharded, false);
      assertEquals((fm.attrs.nested as Any).b, 2);
    },
  );

  await t.step(
    "presets: flagsPolicy fill-missing keeps parsed values and only fills absent keys",
    () => {
      const md = "```sql --tag live --stage uat\nSELECT 1;\n```";
      const p = pipeline();
      const tree = p.parse(md);
      const node = codeNodes(tree)[0];
      assert(node);

      const presets = [
        presetRule(
          "sql defaults",
          "preset --tag default --stage prod",
          (c) => c.lang === "sql",
        ),
      ] as const;

      const fm = codeFrontmatter(node, {
        coerceNumbers: true,
        presets,
        defaults: {
          flagsPolicy: "fill-missing",
        },
      });
      assert(fm);

      // parsed wins for keys that exist
      assertEquals(fm.pi.flags.tag, "live");
      assertEquals(fm.pi.flags.stage, "uat");
    },
  );

  await t.step(
    "presets: flagsPolicy append accumulates defaults + parsed into arrays",
    () => {
      const md = "```sql --tag live --tag=ship\nSELECT 1;\n```";
      const p = pipeline();
      const tree = p.parse(md);
      const node = codeNodes(tree)[0];
      assert(node);

      const presets = [
        presetRule(
          "sql defaults",
          "preset --tag default --tag=base",
          (c) => c.lang === "sql",
        ),
      ] as const;

      const fm = codeFrontmatter(node, {
        coerceNumbers: true,
        presets,
        defaults: {
          flagsPolicy: "append",
        },
      });
      assert(fm);

      // In append policy, defaults are appended AFTER parsed values.
      assertEquals(fm.pi.flags.tag, ["live", "ship", "default", "base"]);
    },
  );

  await t.step(
    "presets: normalization is consistent when both parsing and presets normalize",
    () => {
      const md = "```ts -L 9\ncode\n```";
      const p = pipeline();
      const tree = p.parse(md);
      const node = codeNodes(tree)[0];
      assert(node);

      const normalizeFlagKey = (k: string) => (k === "L" ? "level" : k);

      const presets = [
        presetRule(
          "ts level default",
          "preset -L 7",
          (c) => c.lang === "ts",
          { coerceNumbers: true, normalizeFlagKey },
        ),
      ] as const;

      const fm = codeFrontmatter(node, {
        coerceNumbers: true,
        normalizeFlagKey,
        presets,
        defaults: {
          flagsPolicy: "fill-missing",
        },
      });
      assert(fm);

      // parsed has -L 9, so "level" should be 9 (not overridden by default 7)
      assertEquals(fm.pi.flags.level, 9 as Any);
    },
  );

  /* ---------------------------------------------------------------------- */
  /* PresetsFactory (stateful catalog + implied rules)                        */
  /* ---------------------------------------------------------------------- */

  await t.step(
    "presetsFactory: catalogRulesFromText stores rules and matchingRules uses internal catalog",
    () => {
      // Identity is the first bare word in meta (after cmdLang in the combined
      // `${lang} ${meta}` parse). Here identity = "foo.sql".
      const md = "```sql foo.sql --tag live\nSELECT 1;\n```";
      const p = pipeline();
      const tree = p.parse(md);
      const node = codeNodes(tree)[0];
      assert(node);

      const pf = presetsFactory({
        instrOptions: { coerceNumbers: true },
      });

      // IMPORTANT:
      // The <meta> portion is a full `instructionsFromText()` string.
      // If it starts with `--flag`, that would be treated as cmdLang and excluded.
      // So we explicitly prefix with `preset` here.
      pf.catalogRulesFromText(`
# lang-pattern identity-pattern meta...
sql *.sql preset --tag default --tag=base
sql *.txt preset --tag never
`);

      const matched = pf.matchingRules(node);
      assertEquals(matched.length, 1);

      const fm = codeFrontmatter(node, {
        coerceNumbers: true,
        presets: matched,
        defaults: { flagsPolicy: "append" },
      });
      assert(fm);

      assertEquals(fm.fromPresets.length, 1);
      assertEquals(fm.pi.flags.tag, ["live", "default", "base"]);
    },
  );

  await t.step(
    "presetsFactory: supports regex lang and regex identity patterns",
    () => {
      const md = "```sql foo.sql --tag live\nSELECT 1;\n```";
      const p = pipeline();
      const tree = p.parse(md);
      const node = codeNodes(tree)[0];
      assert(node);

      const pf = presetsFactory({
        instrOptions: { coerceNumbers: true },
      });

      // Prefix meta with `preset` so `--stage` is not treated as cmdLang.
      pf.catalogRulesFromText(`
/sq.*/ /.*\\.sql$/ preset --stage prod
`);

      const matched = pf.matchingRules(node);
      assertEquals(matched.length, 1);

      const fm = codeFrontmatter(node, {
        coerceNumbers: true,
        presets: matched,
      });
      assert(fm);

      assertEquals(fm.pi.flags.stage, "prod");
      assertEquals(fm.fromPresets.length, 1);
    },
  );

  await t.step(
    "presetsFactory: multiple matching rules preserve catalog order and merge defaults across rules",
    () => {
      const md = "```sql foo.sql\nSELECT 1;\n```";
      const p = pipeline();
      const tree = p.parse(md);
      const node = codeNodes(tree)[0];
      assert(node);

      const pf = presetsFactory({
        instrOptions: { coerceNumbers: true },
      });

      pf.catalogRulesFromText(`
sql *.sql preset --tag a
sql *.sql preset --tag b --stage prod
sql *.sql preset --tag c --stage uat
`);

      const matched = pf.matchingRules(node);
      assertEquals(matched.length, 3);

      const fm = codeFrontmatter(node, {
        coerceNumbers: true,
        presets: matched,
        defaults: { flagsPolicy: "append" },
      });
      assert(fm);

      // No parsed tags, so append policy yields defaults in rule order.
      assertEquals(fm.pi.flags.tag, ["a", "b", "c"]);
      // defaults across presets: later rules override earlier defaults (shallow) before posix-pi merges
      // with parsed; since parsed has no stage, final stage should be from the last matching rule.
      assertEquals(fm.pi.flags.stage, "uat");
    },
  );

  await t.step(
    "presetsFactory: non-matching identity yields no rules",
    () => {
      const md = "```sql note.txt\nSELECT 1;\n```";
      const p = pipeline();
      const tree = p.parse(md);
      const node = codeNodes(tree)[0];
      assert(node);

      const pf = presetsFactory({ instrOptions: { coerceNumbers: true } });
      pf.catalogRulesFromText(`
sql *.sql preset --stage prod
`);

      const matched = pf.matchingRules(node);
      assertEquals(matched.length, 0);

      const fm = codeFrontmatter(node, {
        coerceNumbers: true,
        presets: matched,
      });
      assert(fm);

      assertEquals(fm.fromPresets.length, 0);
      assertEquals(fm.pi.flags.stage, undefined);
    },
  );
});
