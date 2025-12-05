import { assertEquals } from "@std/assert";
import { depsResolver } from "./depends.ts";

// NOTE: In a real Spry integration you would likely do:
//
// import { isCodeWithFrontmatterNode } from "./code-frontmatter.ts";
//
// and then:
//
// const injectableCells = allCells.filter(isCodeWithFrontmatterNode);
//
// In this test we simulate that *all* cells are already valid
// "code with frontmatter" nodes to keep the test universal.

/**
 * Minimal stand-in for a code-frontmatter-parsed cell.
 * In real code, this would be your actual mdast `Code` node
 * augmented by code-frontmatter (parsedPI, flags, etc.).
 */
type CodeCell = {
  type: "code";
  nodeName: string;
  parsedPI: {
    firstToken: string;
    flags: Record<string, unknown>;
  };
};

function cell(
  nodeName: string,
  firstToken: string,
  flags: Record<string, unknown> = {},
): CodeCell {
  return {
    type: "code",
    nodeName,
    parsedPI: { firstToken, flags },
  };
}

/**
 * Test-local helper that converts parsedPI.flags into an ImplicitConfig.
 *
 * Supported flags (backward compatible):
 *   - implicit-dep: boolean | string | string[]
 *   - injected-dep: boolean | string | string[]
 *
 * Semantics:
 *   - true / "*"   → wildcard   (".*")
 *   - string       → regex source as-is
 *   - string[]     → multiple sources, "*" entries become ".*"
 */
function implicitFromPI(node: CodeCell): string[] | undefined {
  const flags = node.parsedPI.flags;
  const raw = flags["implicit-dep"] ?? flags["injected-dep"];
  if (raw === undefined || raw === null) return undefined;

  const sources: string[] = [];

  const pushOne = (v: string) => {
    if (!v) return;
    sources.push(v === "*" ? ".*" : v);
  };

  if (typeof raw === "boolean") {
    if (raw) pushOne(".*");
  } else if (typeof raw === "string") {
    pushOne(raw);
  } else if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === "string") pushOne(v);
    }
  }

  return sources.length ? sources : undefined;
}

Deno.test("depsResolver implicit-dep + injected-dep backward-compat", async (t) => {
  const clean = cell("clean-node", "clean");

  // Uses new implicit-dep flag
  const compile = cell("compile-node", "compile", {
    "implicit-dep": ["^build"],
  });

  // Uses old injected-dep flag (backwards compatibility)
  const lintOld = cell("lint-node", "lint", {
    "injected-dep": true,
  });

  const build = cell("build-node", "build");

  const allCells: CodeCell[] = [clean, compile, lintOld, build];

  // In real code, you might do:
  //   const injectableCells = allCells.filter(isCodeWithFrontmatterNode);
  // Here we assume all of them are valid "code with frontmatter" nodes.
  const injectableCells = allCells;

  const { implicitDeps, deps } = depsResolver(injectableCells, {
    // Use parsedPI.firstToken as the task id
    getId: (node) => node.parsedPI.firstToken,
    // Use our test-local mapping from parsed flags to ImplicitConfig
    getImplicit: implicitFromPI,
  });

  await t.step(
    "implicitDeps() resolves new implicit-dep + old injected-dep",
    () => {
      const { implicit, errors } = implicitDeps("build", ["clean"]);

      // compile matches "^build"
      // lintOld (injected-dep=true) matches all → wildcard
      assertEquals(implicit.sort(), ["compile", "lint"].sort());
      assertEquals(errors, []);
    },
  );

  await t.step("deps() merges explicit + implicit", () => {
    const cache = new Map<string, string[]>();

    const merged = deps("build", ["clean"], cache);

    assertEquals(merged, ["compile", "lint", "clean"]);

    // Should hit cache now
    const cached = deps("build", ["clean"], cache);
    assertEquals(cached, merged);
  });

  await t.step("invalid implicit patterns are reported correctly", () => {
    const bad = cell("bad-node", "bad", {
      "implicit-dep": ["(", "*"],
    });

    const resolverWithBad = depsResolver([...injectableCells, bad], {
      getId: (node) => node.parsedPI.firstToken,
      getImplicit: implicitFromPI,
    });

    const { implicit, errors } = resolverWithBad.implicitDeps("anything", []);

    // wildcard still matches, but "(" is invalid regex
    assertEquals(implicit.includes("bad"), true);
    assertEquals(errors, [{ taskId: "bad", regEx: "(" }]);
  });

  await t.step("detectCycles() over explicit + implicit deps", () => {
    // A node that implicitly applies to build, contributing to a cycle
    const lint2 = cell("lint2-node", "lint2", {
      "implicit-dep": ["^build"],
    });

    const cellsWithCycle = [...injectableCells, lint2];

    const {
      deps: depsWithCycle,
      detectCycles: detectCyclesWithCycle,
    } = depsResolver(cellsWithCycle, {
      getId: (node) => node.parsedPI.firstToken,
      getImplicit: implicitFromPI,
    });

    // Simulate explicit deps (e.g. from --deps)
    const explicitMap = new Map<string, string[]>([
      ["build", ["clean", "lint2"]],
      ["lint2", ["build"]],
    ]);

    const allIds = new Set(
      cellsWithCycle.map((c) => c.parsedPI.firstToken),
    );

    const cycles = detectCyclesWithCycle(
      allIds,
      (id) => explicitMap.get(id),
    );

    const flattened = new Set(cycles.flat());
    assertEquals(flattened.has("build"), true);
    assertEquals(flattened.has("lint2"), true);

    // Non-cyclic task “clean” should not be part of the cycle,
    // but still picks up wildcard implicit deps (lint).
    const cleanDeps = depsWithCycle("clean", explicitMap.get("clean"));

    // Wildcard from old injected-dep=true still applies:
    assertEquals(cleanDeps.includes("lint"), true);

    // But clean must not depend on the cyclic nodes:
    assertEquals(cleanDeps.includes("build"), false);
    assertEquals(cleanDeps.includes("lint2"), false);
  });
});
