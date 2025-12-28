/**
 * End-to-end regression test for the Spry CLI SQL output.
 *
 * This module executes the Spry command-line interface programmatically and
 * captures its console output in memory instead of allowing it to print to
 * stdout. The captured output is then compared against a known-good “golden”
 * file to ensure that the CLI behavior and generated SQL remain stable over
 * time.
 *
 * How it works:
 *
 * - The test temporarily overrides `console.log` to intercept all log output
 *   produced by the CLI during execution.
 * - The Spry CLI is invoked exactly as it would be from the command line,
 *   using `CLI(...).parse([...])`, with a fixed set of arguments.
 * - All intercepted log lines are joined into a single string, preserving
 *   line order.
 * - The resulting output is compared against a pre-generated golden file
 *   stored alongside the test.
 * - The golden file represents the expected output produced by running:
 *
 *     ./spry.ts sp spc --package --md Spryfile.md > mod_test.golden.sql
 *
 * - After the assertion, the original `console.log` implementation is restored
 *   to avoid side effects on other tests.
 *
 * Purpose:
 *
 * - Acts as a true end-to-end regression test rather than a unit test.
 * - Detects unintended changes in CLI output formatting, ordering, or content.
 * - Provides high confidence that refactors or dependency updates do not alter
 *   externally visible behavior.
 *
 * This style of test is intentionally black-box: it does not inspect internal
 * state or APIs, only the observable output that real users depend on.
 */
import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { CLI } from "../../../bin/spry.ts";

const goldenPath = (rel: string) => fromFileUrl(import.meta.resolve(rel));

const normalizeAbsolutePaths = (text: string) => {
  const cwd = Deno.cwd();
  const cwdFileUrl = fromFileUrl(new URL(`file://${cwd}/`));

  return text
    .replaceAll(cwd, "ABSOLUTE_PATH")
    .replaceAll(cwdFileUrl, "ABSOLUTE_PATH");
};

Deno.test("End-to-end (e2e) Regression Test", async () => {
  const originalLog = console.log;
  const logs: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  await CLI({ defaultFiles: ["Spryfile.md"] }).parse([
    "sp",
    "spc",
    "--package",
  ]);

  console.log = originalLog;

  // the "golden" file was created using the following command
  // ./spry.ts sp spc --package --md Spryfile.md > mod_test.golden.sql
  assertEquals(
    normalizeAbsolutePaths(logs.join("\n")),
    await Deno.readTextFile(
      goldenPath("./mod_test.golden.sql"),
    ),
  );
});
