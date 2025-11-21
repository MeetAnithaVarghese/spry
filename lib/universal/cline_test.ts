/**
 * @file cline_test.ts
 *
 * Deno unit tests for cline.ts.
 *
 * We assert against actual runtime behavior of tokenizeCline() and
 * parseClineFlags(), which are "CLI-ish", *not* strict Bash.
 *
 * Important: flags prefer "flag consumes next token as its value"
 * over "flag is boolean and next token is positional". That is:
 *
 *   --debug task   => debug = "task", bareTokens excludes "task"
 *   --debug        => debug = true (only when there's no following value)
 *
 * Same for short flags. This is deliberate and we test for it.
 */

import {
  assert,
  assertArrayIncludes,
  assertEquals,
  assertFalse,
  assertStrictEquals,
} from "@std/assert";
import {
  amendClineFlags,
  clineFlagsAsCLI,
  type ClineFlagValue,
  hasEitherFlagOfType,
  hasFlagOfType,
  parseClineFlags,
  tokenizeCline,
} from "./cline.ts";

/**
 * Small assertion helper just for visual clarity in tests.
 * No generics because we care about runtime equality, not compile-time tricks.
 */
function assertFlag(
  parsed: ReturnType<typeof parseClineFlags>,
  key: string,
  expected: ClineFlagValue,
) {
  assertEquals(
    parsed.flags[key],
    expected,
    `flags["${key}"] mismatch`,
  );
}

Deno.test("tokenizeCline basic behaviors", async (t) => {
  await t.step("splits on normal spaces", () => {
    const tokens = tokenizeCline("a b  c   d");
    assertEquals(tokens, ["a", "b", "c", "d"]);
  });

  await t.step("single quotes group literally", () => {
    const tokens = tokenizeCline("cmd 'hello world' tail");
    assertEquals(tokens, ["cmd", "hello world", "tail"]);
  });

  await t.step("double quotes group literally", () => {
    const tokens = tokenizeCline('cmd "hello world" tail');
    assertEquals(tokens, ["cmd", "hello world", "tail"]);
  });

  await t.step("double quotes allow escape of quotes", () => {
    const tokens = tokenizeCline('say "he said: \\"yo\\""');
    assertEquals(tokens, ["say", 'he said: "yo"']);
  });

  await t.step("double quotes allow escape of backslash", () => {
    const tokens = tokenizeCline('say "path C:\\\\tmp"');
    // In double quotes, our tokenizer turns `\\` into `\`
    assertEquals(tokens, ["say", "path C:\\tmp"]);
  });

  await t.step("backslash escapes outside quotes", () => {
    const tokens = tokenizeCline(String.raw`cmd some\ file.txt more\ stuff`);
    assertEquals(tokens, ["cmd", "some file.txt", "more stuff"]);
  });

  await t.step("trailing backslash outside quotes is literal", () => {
    const tokens = tokenizeCline(String.raw`cmd weird\\\\`);
    // trailing "\" at end gets kept literally (we don't drop it)
    assertEquals(tokens, ["cmd", String.raw`weird\\`]);
  });

  await t.step("unclosed single quote: everything after is literal", () => {
    const tokens = tokenizeCline("cmd 'unterminated here");
    assertEquals(tokens, ["cmd", "unterminated here"]);
  });

  await t.step("unclosed double quote: everything after is literal", () => {
    const tokens = tokenizeCline('cmd "unterminated here');
    assertEquals(tokens, ["cmd", "unterminated here"]);
  });

  await t.step("mixed quotes and escapes", () => {
    const tokens = tokenizeCline(
      String.raw`run "a b\"c" 'd e\'f' g\ h`,
    );

    // NOTE: The tokenizer currently (intentionally) treats the single-quoted
    // segment PLUS what follows (`g\ h`) as one combined token instead of
    // splitting them. This is slightly less shell-like but it's consistent
    // with our simpler state machine.
    //
    // So:
    //   "a b\"c"        => a b"c
    //   'd e\'f' g\ h   => "d e\\f g\\ h"
    //
    // We expect exactly three tokens.
    assertEquals(tokens, [
      "run",
      'a b"c',
      "d e\\f g\\ h",
    ]);
  });
});

Deno.test("parseClineFlags basic forms", async (t) => {
  await t.step("bare positional tokens only", () => {
    const r = parseClineFlags("alpha beta gamma");
    assertEquals(r.bareTokens, ["alpha", "beta", "gamma"]);
    assertEquals(r.flags, {});
  });

  await t.step("long flag with =value", () => {
    const r = parseClineFlags("build --out=dist src/main.ts");
    assertEquals(r.bareTokens, ["build", "src/main.ts"]);
    assertFlag(r, "out", "dist");
  });

  await t.step("long flag then value", () => {
    const r = parseClineFlags("build --out dist src/main.ts");
    assertEquals(r.bareTokens, ["build", "src/main.ts"]);
    assertFlag(r, "out", "dist");
  });

  await t.step("bare long boolean flag when nothing follows", () => {
    // This checks "true" behavior specifically.
    // No trailing value after --debug, so it becomes boolean true.
    const r = parseClineFlags("run --debug");
    assertEquals(r.bareTokens, ["run"]);
    assertFlag(r, "debug", true);
  });

  await t.step(
    "long flag followed by a token -> becomes string, not boolean",
    () => {
      // Because "task" immediately follows --debug and does NOT start with "-",
      // parseClineFlags treats it as the value for --debug, not as a positional.
      // This is intentional and consistent with `--key value`.
      const r = parseClineFlags("run --debug task");
      assertEquals(r.bareTokens, ["run"]); // "task" was consumed
      assertFlag(r, "debug", "task");
    },
  );

  await t.step("short flag with =value", () => {
    const r = parseClineFlags("run -o=dist file.ts");
    assertEquals(r.bareTokens, ["run", "file.ts"]);
    assertFlag(r, "o", "dist");
  });

  await t.step("short flag then value", () => {
    const r = parseClineFlags("run -o dist file.ts");
    assertEquals(r.bareTokens, ["run", "file.ts"]);
    assertFlag(r, "o", "dist");
  });

  await t.step("bare short flag when nothing follows", () => {
    const r = parseClineFlags("run -v");
    assertEquals(r.bareTokens, ["run"]);
    assertFlag(r, "v", true);
  });

  await t.step(
    "short flag followed by a token -> becomes string, not boolean",
    () => {
      const r = parseClineFlags("run -v file.ts");
      // "-v file.ts" becomes { v: "file.ts" } and "file.ts" is not positional.
      assertEquals(r.bareTokens, ["run"]);
      assertFlag(r, "v", "file.ts");
    },
  );

  await t.step("repeated same flag promotes to array", () => {
    const r = parseClineFlags(
      "cmd --tag a --tag=b --tag c",
    );
    assertEquals(r.bareTokens, ["cmd"]);
    assertEquals(r.flags.tag, ["a", "b", "c"]);
  });

  await t.step("boolean-ish then then string-ish then repeat", () => {
    // First appearance is bare, so looks boolean-ish, but then we repeat
    // with `=verbose`; we expect final to be array ["true","verbose"].
    const r = parseClineFlags("cmd --debug --debug=verbose");
    assertEquals(r.bareTokens, ["cmd"]);
    assertEquals(r.flags.debug, ["true", "verbose"]);
  });

  await t.step("flag consumes next token so it is NOT bare", () => {
    const r = parseClineFlags("cmd --out dist extra");
    // "--out dist" eats "dist".
    assertEquals(r.bareTokens, ["cmd", "extra"]);
    assertFlag(r, "out", "dist");
  });

  await t.step("flag with no key (just '-' or '--') is ignored", () => {
    const r = parseClineFlags("cmd - -- test");

    // "-" and "--" each produce an empty key so we drop them and
    // DO NOT consume following tokens.
    //
    // bareTokens ends up only including the truly positional tokens:
    assertEquals(r.bareTokens, ["cmd", "test"]);
  });
});

Deno.test("parseClineFlags with base defaults and typing expectations", async (t) => {
  await t.step("base keys survive when not overridden", () => {
    const r = parseClineFlags(
      "deploy prod",
      { debug: false as boolean, env: "dev" as string },
    );

    assertEquals(r.bareTokens, ["deploy", "prod"]);
    assertStrictEquals(r.flags.debug, false);
    assertStrictEquals(r.flags.env, "dev");
  });

  await t.step("argv wins first time a flag appears", () => {
    const r = parseClineFlags(
      "deploy --env prod",
      { env: "staging" as string, debug: false as boolean },
    );

    assertEquals(r.bareTokens, ["deploy"]);
    assertStrictEquals(r.flags.env, "prod");
    assertStrictEquals(r.flags.debug, false);
  });

  await t.step("repetition in argv promotes to array", () => {
    const r = parseClineFlags(
      ["ship", "--tag", "alpha", "--tag", "beta"],
      { tag: "zero" as string },
    );

    assertEquals(r.bareTokens, ["ship"]);
    assertEquals(r.flags.tag as unknown, ["alpha", "beta"]);
  });
});

Deno.test("parseClineFlags exotic quoting + flags", async (t) => {
  await t.step("quoted values with spaces", () => {
    const r = parseClineFlags(
      'run --msg "hello world" "script file.ts"',
    );
    assertEquals(r.bareTokens, ["run", "script file.ts"]);
    assertFlag(r, "msg", "hello world");
  });

  await t.step("escaped spaces outside quotes", () => {
    const r = parseClineFlags(
      String.raw`do --path some\ dir\ name/ fileA`,
    );
    assertEquals(r.bareTokens, ["do", "fileA"]);
    assertFlag(r, "path", "some dir name/");
  });

  await t.step("mix of boolean, string, and arrays", () => {
    const r = parseClineFlags(
      [
        "cmd",
        "--debug",
        "--name",
        "alpha",
        "--name=beta",
        "--name",
        "gamma",
      ],
    );
    assertEquals(r.bareTokens, ["cmd"]);
    assertEquals(r.flags.debug, true);
    assertEquals(r.flags.name, ["alpha", "beta", "gamma"]);
  });

  await t.step("make sure consumed values didn't leak into bareTokens", () => {
    const r = parseClineFlags(
      [
        "x",
        "--out",
        "dist",
        "--foo=bar",
        "--yes",
        "z",
        "q",
      ],
    );

    // Behavior reminder:
    // `--out dist`  => out = "dist" (consumes "dist")
    // `--foo=bar`   => foo = "bar"
    // `--yes z`     => yes = "z" (consumes "z", *not* boolean true)
    // Remaining "q" => bare
    assertEquals(r.bareTokens, ["x", "q"]);
    assertEquals(r.flags.out, "dist");
    assertEquals(r.flags.foo, "bar");
    assertEquals(r.flags.yes, "z");
  });
});

Deno.test("hasFlagOfType narrow checks", async (t) => {
  await t.step("narrow boolean", () => {
    const r = parseClineFlags("cmd --debug --lvl high");

    assertEquals(typeof r.flags.debug, "boolean");
    assertEquals(typeof r.flags.lvl, "string");

    assert(hasFlagOfType(r.flags, "debug", "boolean"));
    assertFalse(hasFlagOfType(r.flags, "debug", "string"));

    if (hasFlagOfType(r.flags, "debug", "boolean")) {
      const v: boolean = r.flags.debug;
      assertStrictEquals(v, true);
    }
  });

  await t.step("narrow string", () => {
    const r = parseClineFlags("cmd --name shahid");
    assert(hasFlagOfType(r.flags, "name", "string"));
    if (hasFlagOfType(r.flags, "name", "string")) {
      const vUpper = r.flags.name.toUpperCase();
      assertEquals(vUpper, "SHAHID");
    }
  });

  await t.step("narrow missing -> false", () => {
    const r = parseClineFlags("cmd --port 8080");
    assertFalse(hasFlagOfType(r.flags, "doesNotExist", "string"));
  });

  await t.step("array-valued flags are typeof 'object'", () => {
    const r = parseClineFlags("cmd --tag a --tag b");
    assert(hasFlagOfType(r.flags, "tag", "object"));
    if (hasFlagOfType(r.flags, "tag", "object")) {
      assert(Array.isArray(r.flags.tag));
      assertArrayIncludes(r.flags.tag as string[], ["a", "b"]);
    }
  });

  await t.step("top-level hasEitherFlagOfType long form present", () => {
    const r = parseClineFlags(
      "render page.md --interpolate true",
      {
        interpolate: false as boolean | string,
        I: false as boolean | string,
      },
    );
    // After parse:
    //   interpolate = "true"
    //   I = false            (from base; not overridden)
    //
    // We ask if either interpolate or I is a string.
    assert(
      hasEitherFlagOfType(r.flags, "interpolate", "I", "string"),
    );
    if (hasEitherFlagOfType(r.flags, "interpolate", "I", "string")) {
      // TS: treat both as string here.
      const vA = (r.flags.interpolate as string).toUpperCase();
      const vB = r.flags.I as string | undefined;
      // vA should be "TRUE"
      assertStrictEquals(vA, "TRUE");
      // vB might be "false" if base left it boolean false,
      // but from TS pov inside guard it's string | undefined,
      // so runtime check below is safe:
      if (typeof vB === "string") {
        assertStrictEquals(typeof vB, "string");
      }
    }
  });

  await t.step("top-level hasEitherFlagOfType short form present", () => {
    const r = parseClineFlags(
      "render page.md -I yes",
      {
        interpolate: false as boolean | string,
        I: false as boolean | string,
      },
    );
    // After parse:
    //   I = "yes"           (string from CLI)
    //   interpolate = false (boolean from base)
    //
    // Asking for "string" should pass because I is a string.
    assert(
      hasEitherFlagOfType(r.flags, "interpolate", "I", "string"),
    );
    if (hasEitherFlagOfType(r.flags, "interpolate", "I", "string")) {
      const vShort = (r.flags.I as string).toUpperCase();
      assertStrictEquals(vShort, "YES");
    }

    // Asking for "boolean" should ALSO pass because interpolate is boolean.
    // This is important: hasEitherFlagOfType returns true if EITHER key
    // matches the expected runtime typeof.
    assert(
      hasEitherFlagOfType(r.flags, "interpolate", "I", "boolean"),
    );
  });

  await t.step(
    "top-level hasEitherFlagOfType neither present with expected type",
    () => {
      const r = parseClineFlags(
        "render page.md",
        {
          interpolate: false as boolean,
          I: false as boolean,
        },
      );
      // Both interpolate and I exist (from base) and are boolean false.
      // So "boolean" should pass, because both match.
      assert(
        hasEitherFlagOfType(r.flags, "interpolate", "I", "boolean"),
      );

      // "string" should fail at runtime because neither is a string.
      assertFalse(
        hasEitherFlagOfType(r.flags, "interpolate", "I", "string"),
      );
    },
  );
});

Deno.test("amendClineFlags behavior", async (t) => {
  await t.step(
    "overrides scalars, preserves old bareTokens, carries forward old booleans",
    () => {
      // Original parse
      const base = parseClineFlags(
        "deploy serviceA --env prod --debug",
      );
      // Amend with new info
      const amended = amendClineFlags(
        base,
        "--env staging --tag v1",
      );

      // bareTokens should remain from the original parse (not extended)
      assertEquals(amended.bareTokens, base.bareTokens);

      // env should now be "staging" (new overrides old)
      assertStrictEquals(amended.flags.env, "staging");

      // debug should still be true even though we didn't mention it in the amendment
      assertStrictEquals(amended.flags.debug, true);

      // new flag should appear
      assertStrictEquals(amended.flags.tag, "v1");
    },
  );

  await t.step("extends repeated flags without losing prior values", () => {
    // Start with a single --tag one
    const first = parseClineFlags("cmd --tag one");

    // Now append two more tags
    const second = amendClineFlags(
      first,
      "--tag two --tag three",
    );

    // We expect ["one","two","three"] not just ["two","three"]
    assertEquals(second.flags.tag, ["one", "two", "three"]);

    // bareTokens remain from original
    assertEquals(second.bareTokens, first.bareTokens);
  });

  await t.step("adds entirely new flags if missing", () => {
    const start = parseClineFlags("run --debug");
    const next = amendClineFlags(start, "--level high");

    assertStrictEquals(next.flags.debug, true);
    assertStrictEquals(next.flags.level, "high");

    // bareTokens still from 'run'
    assertEquals(next.bareTokens, start.bareTokens);
  });
});

Deno.test("clineFlagsAsCLI round-trip", async (t) => {
  await t.step(
    "recreates flags/bareTokens for mixed booleans/strings/arrays",
    () => {
      const original = parseClineFlags(
        `build "src/main lib.ts" --out dist --tag a --tag "b c" -v`,
      );

      // Turn it back into a CLI string
      const cli = clineFlagsAsCLI(original);

      // Parse that CLI string again
      const roundTripped = parseClineFlags(cli);

      // bareTokens should match exactly
      assertEquals(roundTripped.bareTokens, original.bareTokens);

      // flags should deep-equal for all representable cases
      assertEquals(roundTripped.flags, original.flags);
    },
  );

  await t.step("handles boolean-only flags", () => {
    const original = parseClineFlags("run --debug -v taskX");
    // Note: because `-v taskX` treats `v` as "taskX" (string),
    // and `taskX` is *not* positional in that scenario,
    // this gives us a nice coverage of boolean + string.

    const cli = clineFlagsAsCLI(original);
    const again = parseClineFlags(cli);

    assertEquals(again.bareTokens, original.bareTokens);
    assertEquals(again.flags, original.flags);
  });
});
