import { assert, assertEquals, assertThrows } from "@std/assert";
import { remark } from "remark";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { Code } from "types/mdast";
import { ensureLanguageByIdOrAlias } from "../../universal/code.ts";
import {
  codeFrontmatterNDF,
  CodeFrontmatterOptions,
  ensureCodeFrontmatter,
  parseFrontmatterFromCode,
} from "./code-frontmatter.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function pipeline() {
  // remark is only used to build an mdast tree; enrichment is done by
  // ensureCodeFrontmatter(), not a remark plugin.
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
  const fm = ensureCodeFrontmatter(node, opts);
  assert(fm, "Expected frontmatter to be parsed");
  return { node, fm: fm! };
}

Deno.test("CodeFrontmatter enrichment ...", async (t) => {
  await t.step("basic: bare tokens and boolean flags", () => {
    const md = "```bash first -x --flag\ncode\n```";
    const { node, fm } = enrichFirstCode(md);

    // verify the data-bag is actually attached
    assert(codeFrontmatterNDF.is(node));

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

    const fm = ensureCodeFrontmatter(node, opts);
    assert(fm);

    // all keys normalized to lower-case
    assertEquals(fm.langSpec?.id, "python");
    assertEquals(fm.pi.pos, ["env", "e", "stage"]);
    assertEquals(fm.pi.flags.env, "prod");
    assertEquals(fm.pi.flags.e, "qa");
    assertEquals(fm.pi.flags.stage, true);
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

        const fm = ensureCodeFrontmatter(node, {
          coerceNumbers: true,
          // onAttrsParseError left as default ("ignore")
        });
        assert(fm);
        // ignored on error -> attrs should be empty-ish
        assertEquals(fm!.attrs ?? {}, {});
      }

      // 'throw': parse error should propagate from parseFrontmatterFromCode
      assertThrows(() => {
        const p = pipeline();
        const tree = p.parse(invalid);
        const node = codeNodes(tree)[0];
        assert(node);

        // This should throw from instructionsFromText / JSON5 parse
        ensureCodeFrontmatter(node, {
          coerceNumbers: true,
          onAttrsParseError: "throw",
        });
      });
    },
  );

  await t.step(
    "idempotent (calling ensureCodeFrontmatter twice does not duplicate or change data)",
    () => {
      const md = "```ts a b c {x:1}\ncode\n```";
      const p = pipeline();
      const tree = p.parse(md);
      const node = codeNodes(tree)[0];
      assert(node);

      const fm1 = ensureCodeFrontmatter(node, { coerceNumbers: true });
      const fm2 = ensureCodeFrontmatter(node, { coerceNumbers: true });

      assert(fm1);
      assert(fm2);

      // Data-bag is attached and stable
      assert(codeFrontmatterNDF.is(node));
      const fmFromBag = codeFrontmatterNDF.get(node);
      assert(fmFromBag);
      assertEquals(fmFromBag!.lang, fm1!.lang);
      assertEquals(fmFromBag!.pi.pos, fm1!.pi.pos);
      assertEquals(fmFromBag!.attrs?.x, 1);
    },
  );

  await t.step("public helper parseFrontmatterFromCode()", () => {
    const md = "```sql --stage prod {sharded: true}\nSELECT 1;\n```";
    const p = pipeline();
    const tree = p.parse(md);
    const node = codeNodes(tree)[0];
    assert(node);

    const parsed = parseFrontmatterFromCode(node, {
      coerceNumbers: true,
    });
    assert(parsed);
    assertEquals(parsed?.lang, "sql");
    assertEquals(parsed?.pi.flags.stage, "prod");
    assertEquals(parsed?.attrs?.sharded, true);
  });

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
    },
  );
});
