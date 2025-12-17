// lib/universal/posix-pi_test.ts
import { assert, assertEquals, assertThrows } from "@std/assert";
import { instructionsFromText, queryPosixPI } from "./posix-pi.ts";

Deno.test("instructionsFromText basic and edge behaviors", async (t) => {
  await t.step("empty text yields empty pi and no attrs", () => {
    const { pi, attrs, cmdLang, cli, attrsText } = instructionsFromText("");
    assertEquals(pi.args, []);
    assertEquals(pi.pos, []);
    assertEquals(pi.flags, {});
    assertEquals(pi.count, 0);
    assertEquals(pi.posCount, 0);
    assertEquals(attrs, undefined);
    assertEquals(cmdLang, undefined);
    assertEquals(cli, "");
    assertEquals(attrsText, undefined);
  });

  await t.step("whitespace-only text behaves like empty", () => {
    const { pi, attrs, cmdLang, cli, attrsText } = instructionsFromText(
      "   \t  ",
    );
    assertEquals(pi.args, []);
    assertEquals(pi.pos, []);
    assertEquals(pi.flags, {});
    assertEquals(pi.count, 0);
    assertEquals(pi.posCount, 0);
    assertEquals(attrs, undefined);
    assertEquals(cmdLang, undefined);
    assertEquals(cli, "");
    assertEquals(attrsText, undefined);
  });

  await t.step(
    "single cmd/lang token is captured but not parsed as flag",
    () => {
      const { pi, attrs, cmdLang, cli, attrsText } = instructionsFromText("ts");
      assertEquals(pi.args, ["ts"]);
      assertEquals(pi.pos, []);
      assertEquals(pi.flags, {});
      assertEquals(pi.count, 1);
      assertEquals(pi.posCount, 0);
      assertEquals(attrs, undefined);
      assertEquals(cmdLang, "ts");
      assertEquals(cli, "ts");
      assertEquals(attrsText, undefined);
    },
  );

  await t.step(
    "cmd/lang plus bare token becomes boolean flag and pos key",
    () => {
      const { pi, cmdLang, cli } = instructionsFromText("sql important");
      assertEquals(pi.args, ["sql", "important"]);
      assertEquals(pi.pos, ["important"]);
      assertEquals(pi.flags, { important: true });
      assertEquals(pi.count, 2);
      assertEquals(pi.posCount, 1);
      assertEquals(cmdLang, "sql");
      assertEquals(cli, "sql important");
    },
  );

  await t.step("long and short flags with =value forms", () => {
    const { pi, cmdLang } = instructionsFromText(
      "js --limit=10 -x=9 --feature=true -f=false",
    );

    assertEquals(pi.args, [
      "js",
      "--limit=10",
      "-x=9",
      "--feature=true",
      "-f=false",
    ]);
    assertEquals(pi.pos.sort(), ["limit", "x", "feature", "f"].sort());

    assertEquals(pi.flags, {
      limit: "10",
      x: "9",
      feature: "true",
      f: "false",
    });
    assertEquals(cmdLang, "js");
  });

  await t.step("two-token flags with and without numeric coercion", () => {
    const raw = "ts --level 2 -n 3 --name main";

    const { pi: piNoCoerce } = instructionsFromText(raw);
    assertEquals(piNoCoerce.flags, {
      level: "2",
      n: "3",
      name: "main",
    });

    const { pi: piCoerce } = instructionsFromText(raw, { coerceNumbers: true });
    assertEquals(piCoerce.flags, {
      level: 2,
      n: 3,
      name: "main",
    });

    assertEquals(piCoerce.pos.sort(), ["level", "n", "name"].sort());
  });

  await t.step(
    "bare tokens accumulate as boolean flags and pos entries",
    () => {
      const { pi } = instructionsFromText("md important draft internal");
      assertEquals(pi.flags, {
        important: true,
        draft: true,
        internal: true,
      });
      assertEquals(pi.pos.sort(), ["important", "draft", "internal"].sort());
    },
  );

  await t.step("repeated flags accumulate into arrays", () => {
    const { pi } = instructionsFromText(
      "sql --tag a --tag=b --tag c --tag=done",
    );

    assertEquals(pi.flags, {
      tag: ["a", "b", "c", "done"],
    });

    assertEquals(pi.pos, ["tag", "tag", "tag", "tag"]);
  });

  await t.step("normalizeFlagKey is applied to flags and bare tokens", () => {
    const { pi, cmdLang } = instructionsFromText(
      "ts -L=1 -L 2 level3 --tag important tag2",
      {
        normalizeFlagKey: (k) => k.toLowerCase(),
      },
    );

    assertEquals(
      pi.pos.sort(),
      ["l", "l", "level3", "tag", "tag2"].sort(),
    );

    assertEquals(pi.flags, {
      l: ["1", "2"],
      level3: true,
      tag: "important",
      tag2: true,
    });
    assertEquals(cmdLang, "ts");
  });

  await t.step("POSIX-style quoting preserves spaces inside quotes", () => {
    const { pi } = instructionsFromText(
      `ts --name "hello world" --path 'a b/c' tag`,
    );

    assertEquals(pi.flags, {
      name: "hello world",
      path: "a b/c",
      tag: true,
    });
    assertEquals(pi.pos.sort(), ["name", "path", "tag"].sort());
  });

  await t.step(
    "attrs-only string (no cmd/lang) parses JSON5 and has no CLI tokens",
    () => {
      const { pi, attrs, cmdLang, cli, attrsText } = instructionsFromText(
        "{ foo: 1, bar: 'baz' }",
      );

      assertEquals(pi.args, []);
      assertEquals(pi.flags, {});
      assertEquals(pi.pos, []);
      assertEquals(pi.count, 0);
      assertEquals(pi.posCount, 0);

      assert(attrs);
      assertEquals(attrs, { foo: 1, bar: "baz" });
      assertEquals(cmdLang, undefined);
      assertEquals(cli, "");
      assertEquals(attrsText, "{ foo: 1, bar: 'baz' }");
    },
  );

  await t.step("cmd/lang plus attrs parses both", () => {
    const { pi, attrs, cmdLang, cli, attrsText } = instructionsFromText(
      "js --tag important { id: 'foo', count: 3 }",
    );

    assertEquals(pi.args, ["js", "--tag", "important"]);
    assertEquals(pi.flags, { tag: "important" });
    assertEquals(pi.pos, ["tag"]);

    assert(attrs);
    assertEquals(attrs, { id: "foo", count: 3 });

    assertEquals(cmdLang, "js");
    assertEquals(cli, "js --tag important");
    assertEquals(attrsText, "{ id: 'foo', count: 3 }");
  });

  await t.step("attrs parsing ignores invalid JSON5 by default", () => {
    const { pi, attrs, attrsText } = instructionsFromText(
      "ts --x 1 { not: valid: json5 }",
    );

    assertEquals(pi.flags, { x: "1" });
    assert(attrs);
    assertEquals(attrs, {});
    assertEquals(attrsText, "{ not: valid: json5 }");
  });

  await t.step(
    "attrs parsing stores __raw when onAttrsParseError='store'",
    () => {
      const { attrs, attrsText } = instructionsFromText(
        "ts --x 1 { not: valid: json5 }",
        { onAttrsParseError: "store" },
      );

      assert(attrs);
      const a = attrs as Record<string, unknown>;
      assertEquals(Object.keys(a).length, 1);
      assert(typeof a.__raw === "string");
      assert((a.__raw as string).trim().startsWith("{"));
      assertEquals(attrsText, "{ not: valid: json5 }");
    },
  );

  await t.step("attrs parsing throws when onAttrsParseError='throw'", () => {
    assertThrows(() =>
      instructionsFromText("ts { not: valid: json5 }", {
        onAttrsParseError: "throw",
      })
    );
  });

  await t.step(
    "cmd/lang is excluded from flags by default, but can be retained",
    () => {
      const { pi: piDefault, cmdLang: cmdDefault } = instructionsFromText(
        "--lang --flag value",
      );
      assertEquals(piDefault.args, ["--lang", "--flag", "value"]);
      assertEquals(piDefault.flags, { flag: "value" });
      assertEquals(piDefault.pos, ["flag"]);
      assertEquals(cmdDefault, "--lang");

      const { pi: piRetain, cmdLang: cmdRetain } = instructionsFromText(
        "--lang --flag value",
        { retainCmdLang: true },
      );
      assertEquals(piRetain.args, ["--lang", "--flag", "value"]);
      assertEquals(piRetain.flags, {
        lang: true,
        flag: "value",
      });
      assertEquals(piRetain.pos.sort(), ["lang", "flag"].sort());
      assertEquals(cmdRetain, "--lang");
    },
  );

  await t.step("no attrs when no { token is present", () => {
    const { attrs, attrsText } = instructionsFromText("ts --x 1 --y=2");
    assertEquals(attrs, undefined);
    assertEquals(attrsText, undefined);
  });

  // ---------------------------------------------------------------------------
  // Defaults behavior (new)
  // ---------------------------------------------------------------------------

  await t.step(
    "defaults: flagsPolicy fill-missing only fills absent keys",
    () => {
      const { pi } = instructionsFromText("ts --a 1 --b 9", {
        defaults: {
          pi: { flags: { a: "0", b: "2", c: "3" } },
          flagsPolicy: "fill-missing",
        },
      });

      assertEquals(pi.flags, { a: "1", b: "9", c: "3" });
    },
  );

  await t.step("defaults: flagsPolicy override replaces parsed keys", () => {
    const { pi } = instructionsFromText("ts --a 1 --b 9", {
      defaults: {
        pi: { flags: { a: "0", b: "2", c: "3" } },
        flagsPolicy: "override",
      },
    });

    assertEquals(pi.flags, { a: "0", b: "2", c: "3" });
  });

  await t.step("defaults: flagsPolicy append accumulates into arrays", () => {
    const { pi } = instructionsFromText("ts --b 9 --a 1", {
      defaults: {
        pi: { flags: { a: "0", b: "2", c: "3" } },
        flagsPolicy: "append",
      },
    });

    assertEquals(pi.flags, { b: ["9", "2"], a: ["1", "0"], c: "3" });
  });

  await t.step(
    "defaults: default flag keys are normalized consistently",
    () => {
      // Important: if -L canonicalizes to "level", -l should too (same option).
      const normalizeFlagKey = (k: string) =>
        (k === "L" || k === "l") ? "level" : k.toLowerCase();

      const { pi } = instructionsFromText("ts -L 2", {
        normalizeFlagKey,
        defaults: {
          pi: { flags: { "--LEVEL": "9", "-l": "7", "Tag": "x" } },
          flagsPolicy: "fill-missing",
        },
      });

      // parsed sets level=2, so defaults for level do not apply (fill-missing)
      // tag comes from defaults
      assertEquals(pi.flags, { level: "2", tag: "x" });
    },
  );

  await t.step(
    "defaults: attrsPolicy fill-missing (shallow) lets parsed override",
    () => {
      const { attrs } = instructionsFromText(
        "ts { a: 1, nested: { x: 9 } }",
        {
          defaults: {
            attrs: { a: 0, b: 2, nested: { x: 1, y: 2 } },
            attrsPolicy: "fill-missing",
          },
        },
      );

      assert(attrs);
      assertEquals(attrs, { a: 1, b: 2, nested: { x: 9 } });
    },
  );

  await t.step(
    "defaults: attrsPolicy override (shallow) lets defaults override parsed",
    () => {
      const { attrs } = instructionsFromText(
        "ts { a: 1, nested: { x: 9 } }",
        {
          defaults: {
            attrs: { a: 0, b: 2, nested: { x: 1, y: 2 } },
            attrsPolicy: "override",
          },
        },
      );

      assert(attrs);
      assertEquals(attrs, { a: 0, b: 2, nested: { x: 1, y: 2 } });
    },
  );

  await t.step(
    "defaults: attrsPolicy deep-fill-missing keeps parsed and fills only missing",
    () => {
      const { attrs } = instructionsFromText(
        "ts { a: 1, nested: { x: 9 } }",
        {
          defaults: {
            attrs: { a: 0, b: 2, nested: { x: 1, y: 2 } },
            attrsPolicy: "deep-fill-missing",
          },
        },
      );

      assert(attrs);
      assertEquals(attrs, { a: 1, b: 2, nested: { x: 9, y: 2 } });
    },
  );

  await t.step(
    "defaults: attrsPolicy deep-override overwrites nested keys with parsed",
    () => {
      const { attrs } = instructionsFromText(
        "ts { a: 1, nested: { x: 9 } }",
        {
          defaults: {
            attrs: { a: 0, b: 2, nested: { x: 1, y: 2 } },
            attrsPolicy: "deep-override",
          },
        },
      );

      assert(attrs);
      assertEquals(attrs, { a: 1, b: 2, nested: { x: 9, y: 2 } });
    },
  );

  await t.step(
    "defaults: by default, attrs are NOT returned when only defaults exist",
    () => {
      const { attrs, attrsText } = instructionsFromText("ts --x 1", {
        defaults: {
          attrs: { a: 1 },
        },
      });

      assertEquals(attrsText, undefined);
      assertEquals(attrs, undefined);
    },
  );

  await t.step(
    "defaults: returnAttrsWhenDefaulted=true returns attrs even without attrsText",
    () => {
      const { attrs, attrsText } = instructionsFromText("ts --x 1", {
        defaults: {
          attrs: { a: 1 },
          returnAttrsWhenDefaulted: true,
        },
      });

      assertEquals(attrsText, undefined);
      assert(attrs);
      assertEquals(attrs, { a: 1 });
    },
  );

  await t.step(
    "defaults: invalid attrsText still merges defaults (ignore mode)",
    () => {
      const { attrs } = instructionsFromText("ts { not: valid: json5 }", {
        defaults: {
          attrs: { a: 1, nested: { y: 2 } },
          attrsPolicy: "deep-fill-missing",
        },
      });

      assert(attrs);
      assertEquals(attrs, { a: 1, nested: { y: 2 } });
    },
  );

  await t.step(
    "defaults: onAttrsParseError='store' preserves __raw and defaults still apply",
    () => {
      const { attrs } = instructionsFromText("ts { not: valid: json5 }", {
        onAttrsParseError: "store",
        defaults: {
          attrs: { a: 1 },
          attrsPolicy: "fill-missing",
        },
      });

      assert(attrs);
      const a = attrs as Record<string, unknown>;
      assert(typeof a.__raw === "string");
      assertEquals(a.a, 1);
    },
  );

  await t.step("defaults: empty defaults has no effect", () => {
    const { pi, attrs } = instructionsFromText("ts --a 1");
    const { pi: pi2, attrs: attrs2 } = instructionsFromText("ts --a 1", {
      defaults: {},
    });

    assertEquals(pi, pi2);
    assertEquals(attrs, attrs2);
  });
});

Deno.test("queryPosixPI convenience helpers", async (t) => {
  await t.step("extracts bare words excluding cmdLang and flag values", () => {
    const info = "ts PARTIAL main --level 2 tag another";
    const { pi, attrs } = instructionsFromText(info, {
      coerceNumbers: true,
    });

    const q = queryPosixPI(pi, attrs);

    assertEquals(q.cmdLang, "ts");
    assertEquals(q.bareWords, ["PARTIAL", "main", "tag", "another"]);
    assertEquals(q.getFirstBareWord(), "PARTIAL");
    assertEquals(q.getSecondBareWord(), "main");
    assertEquals(q.getBareWord(3), "another");
    assertEquals(q.getBareWord(99), undefined);
  });

  await t.step("getFlag and hasFlag respect aliases and normalization", () => {
    const info = "ts -s foo --long bar";
    const { pi, attrs } = instructionsFromText(info, {
      normalizeFlagKey: (k) => (k === "s" ? "short" : k),
    });

    const q = queryPosixPI(pi, attrs, {
      normalizeFlagKey: (k) => (k === "s" ? "short" : k),
    });

    assertEquals(pi.flags, {
      short: "foo",
      long: "bar",
    });

    assertEquals(q.getFlag<string>("s"), "foo");
    assertEquals(q.getFlag<string>("short"), "foo");
    assertEquals(q.getFlag<string>("long"), "bar");
    assertEquals(q.getFlag("missing"), undefined);

    assertEquals(q.hasFlag("short"), true);
    assertEquals(q.hasFlag("s"), true);
    assertEquals(q.hasFlag("missing"), false);
  });

  await t.step("getFlagValues flattens arrays across aliases", () => {
    const info = "ts -t a --tag b --tags c";
    const normalizeFlagKey = (k: string) =>
      k === "t" || k === "tags" ? "tag" : k;

    const { pi, attrs } = instructionsFromText(info, {
      normalizeFlagKey,
    });

    const q = queryPosixPI(pi, attrs, { normalizeFlagKey });

    assertEquals(pi.flags, {
      tag: ["a", "b", "c"],
    });

    assertEquals(
      q.getFlagValues<string>("t", "tag", "tags"),
      ["a", "b", "c"],
    );
  });

  await t.step(
    "isEnabled treats bare and explicit boolean flags consistently",
    () => {
      const info = "ts --debug -v --feature=false";
      const normalizeFlagKey = (k: string) => k === "v" ? "verbose" : k;

      const { pi, attrs } = instructionsFromText(info, {
        normalizeFlagKey,
      });

      const q = queryPosixPI(pi, attrs, { normalizeFlagKey });

      assertEquals(pi.flags, {
        debug: true,
        verbose: true,
        feature: "false",
      });

      assertEquals(q.isEnabled("debug"), true);
      assertEquals(q.isEnabled("v", "verbose"), true);

      assertEquals(q.isEnabled("feature"), true);
      assertEquals(q.isEnabled("missing"), false);
    },
  );

  await t.step("query wrapper mirrors attrs from instructionsFromText", () => {
    const info = "js --tag important { id: 'foo', count: 3 }";
    const { pi, attrs } = instructionsFromText(info);

    const q = queryPosixPI(pi, attrs);

    assertEquals(q.attrs, { id: "foo", count: 3 });
    assertEquals(q.getFlag("tag"), "important");
    assertEquals(q.cmdLang, "js");
  });
});
