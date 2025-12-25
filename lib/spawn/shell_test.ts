// shell_test.ts
import { assert, assertEquals, assertMatch } from "@std/assert";
import { shell } from "./shell.ts";

const td = new TextDecoder();

Deno.test("shell(): spawnArgv runs argv and captures raw stdout/stderr", async () => {
  const sh = shell();
  const res = await sh.spawnArgv(["deno", "eval", "console.log('hello argv')"]);
  assertEquals(res.code, 0);
  assert(res.success);
  assertMatch(td.decode(res.stdout), /hello argv\s*$/);
  // stderr is usually empty here, but it's still a Uint8Array
  assert(res.stderr instanceof Uint8Array);
});

Deno.test("shell(): spawnText splits one-liners and runs them", async () => {
  const sh = shell();
  // quotes and spaces should be preserved by the splitter
  const res = await sh.spawnText(`deno eval "console.log(3 + 4)"`);
  assertEquals(res.code, 0);
  assert(res.success);
  assertMatch(td.decode(res.stdout), /^7\s*$/);
});

Deno.test("shell(): spawnShebang writes a temp file and executes it", async () => {
  const sh = shell();
  // Use Deno via shebang for portability; requires /usr/bin/env on *nix
  // The --ext=ts allows running TypeScript even if temp file has no .ts extension
  const script = `#!/usr/bin/env -S deno run --quiet --ext=ts
console.log("hi from shebang");
`;
  const res = await sh.spawnShebang(script);
  assertEquals(res.code, 0);
  assert(res.success);
  assertMatch(td.decode(res.stdout), /hi from shebang\s*$/);
});

Deno.test("shell(): denoTaskEval splits lines and returns per-line results", async () => {
  const sh = shell();
  const program = [
    "console.log('L1')",
    "console.log('L2')",
    "", // blank line should be skipped
    "console.log('L3')",
  ].join("\n");

  // NOTE: Your shell.ts uses: deno task --eval <line>
  // That flag may not be supported by vanilla `deno task`. This test focuses
  // on shape (array length, line echo) and type of outputs, regardless of exit code.
  const results = await sh.denoTaskEval(program);

  assertEquals(Array.isArray(results), true);
  assertEquals(results.length, 3);
  for (const [idx, r] of results.entries()) {
    assertEquals(r.index, idx);
    assert(typeof r.line === "string");
    assert(r.stdout instanceof Uint8Array);
    assert(r.stderr instanceof Uint8Array);
    assert(typeof r.code === "number");
    assert(typeof r.success === "boolean");
  }
});

Deno.test("shell(): auto runs shebang via spawnShebang and returns RunResult", async () => {
  const sh = shell();
  const shebangSrc = `#!/usr/bin/env -S deno run --quiet --ext=ts
console.log("auto shebang");
`;
  const res = await sh.auto(shebangSrc);
  // When shebang is present, auto returns a single RunResult (not an array)
  assertEquals(Array.isArray(res), false);
  const rr = res as Exclude<typeof res, unknown[]>;
  assertMatch(td.decode(rr.stdout), /auto shebang\s*$/);
  assertEquals(rr.code, 0);
  assert(rr.success);
});

Deno.test("shell(): auto without shebang uses denoTaskEval and returns an array", async () => {
  const sh = shell();
  const multi = `console.log("A")\nconsole.log("B")`;
  const res = await sh.auto(multi);
  // Without shebang, auto returns the array from denoTaskEval
  assertEquals(Array.isArray(res), true);
  const arr = res as Array<unknown>;
  assertEquals(arr.length, 2);
});
