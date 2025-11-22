// safe-data_test.ts
//
// Deno 2.5 unit tests for safe-data.ts.
// Uses Deno.test + subtests (t.step) and JSR std/assert.

import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import * as z from "@zod/zod";

import type { Root } from "types/mdast";
import type { Node } from "types/unist";

import { nodeErrors } from "./issue.ts";
import {
  type ArrayDataFactory,
  attachData,
  collectData,
  type DataFactory,
  deepMerge,
  ensureData,
  forEachData,
  getData,
  hasAnyData,
  isDataSupplier,
  mergeData,
  nodeArrayDataFactory,
  nodeDataFactory,
  safeNodeArrayDataFactory,
  safeNodeDataFactory,
} from "./safe-data.ts";

/* -------------------------------------------------------------------------- */
/* Minimal structural helpers for Root / Node in tests                        */
/* -------------------------------------------------------------------------- */

type TestNode = Node & {
  children?: TestNode[];
};

type TestRoot = Root & {
  children: TestNode[];
};

function makeRoot(children: TestNode[] = []): TestRoot {
  return { type: "root", children } as TestRoot;
}

function makeNode(type: string, children: TestNode[] = []): TestNode {
  return { type, children } as TestNode;
}

/* -------------------------------------------------------------------------- */
/* Core primitive tests                                                       */
/* -------------------------------------------------------------------------- */

Deno.test("core primitives", async (t) => {
  await t.step("ensureData creates data bag when missing", () => {
    const n = makeNode("paragraph");
    const data = ensureData(n);
    assert(data);
    assertEquals(data, {});
    assert("data" in n);
  });

  await t.step("attachData stores typed data on a node", () => {
    interface Meta {
      name: string;
      score: number;
    }

    const n = makeNode("paragraph");
    const withMeta = attachData<TestNode, "meta", Meta>(
      n,
      "meta",
      { name: "foo", score: 42 },
    );

    const meta = (withMeta.data as { meta: Meta }).meta;
    assertEquals(meta.name, "foo");
    assertEquals(meta.score, 42);
  });

  await t.step(
    "getData retrieves data by key and returns undefined if missing",
    () => {
      const n1 = makeNode("paragraph");
      const value1 = getData<unknown, TestNode, "foo">(n1, "foo");
      assertEquals(value1, undefined);

      const n2 = makeNode("paragraph");
      n2.data = { foo: 123 };
      const value2 = getData<number, TestNode, "foo">(n2, "foo");
      assertStrictEquals(value2, 123);
    },
  );

  await t.step("getData with schema throws on invalid value", () => {
    const schema = z.object({
      name: z.string(),
      score: z.number(),
    });

    const bad = makeNode("paragraph");
    bad.data = { meta: { name: "not-ok", score: "NaN" } };

    assertThrows(
      () =>
        getData<{ name: string; score: number }, TestNode, "meta">(
          bad,
          "meta",
          schema,
        ),
      Error,
    );
  });

  await t.step("isDataSupplier works as a type guard", () => {
    interface Meta {
      flag: boolean;
    }

    const n1 = makeNode("paragraph");
    const n2 = makeNode("paragraph");
    n2.data = { meta: { flag: true } as Meta };

    assert(!isDataSupplier<Meta, TestNode, "meta">(n1, "meta"));
    assert(isDataSupplier<Meta, TestNode, "meta">(n2, "meta"));

    if (isDataSupplier<Meta, TestNode, "meta">(n2, "meta")) {
      const meta = (n2.data as { meta: Meta }).meta;
      assertEquals(meta.flag, true);
    }
  });

  await t.step("collectData finds values for a key in the tree", () => {
    interface Info {
      id: string;
    }

    const tree = makeRoot([
      (() => {
        const n = makeNode("paragraph");
        n.data = { info: { id: "p1" } as Info };
        return n;
      })(),
      makeNode("paragraph"),
      (() => {
        const n = makeNode("heading");
        n.data = { info: { id: "h1" } as Info };
        return n;
      })(),
    ]);

    const all = collectData<Info, "info">(tree, "info");
    assertEquals(all, [{ id: "p1" }, { id: "h1" }]);
  });

  await t.step("forEachData walks all nodes with the given key", () => {
    interface Info {
      id: string;
    }

    const tree = makeRoot([
      (() => {
        const n = makeNode("paragraph");
        n.data = { info: { id: "p1" } as Info };
        return n;
      })(),
      makeNode("paragraph"),
      (() => {
        const n = makeNode("heading");
        n.data = { info: { id: "h1" } as Info };
        return n;
      })(),
    ]);

    const ids: string[] = [];
    forEachData<Info, "info">(
      tree,
      "info",
      (value, owner) => {
        ids.push(value.id);
        assert(owner.data);
      },
    );

    ids.sort();
    assertEquals(ids, ["h1", "p1"]);
  });

  await t.step(
    "hasAnyData returns true only when at least one node has the key",
    () => {
      const tree1 = makeRoot([
        makeNode("paragraph"),
        makeNode("heading"),
      ]);

      const tree2 = makeRoot([
        (() => {
          const n = makeNode("paragraph");
          n.data = { meta: 1 };
          return n;
        })(),
        makeNode("heading"),
      ]);

      assert(!hasAnyData(tree1, "meta"));
      assert(hasAnyData(tree2, "meta"));
    },
  );
});

/* -------------------------------------------------------------------------- */
/* deepMerge / mergeData                                                      */
/* -------------------------------------------------------------------------- */

Deno.test("deepMerge and mergeData", async (t) => {
  await t.step("deepMerge merges nested plain objects", () => {
    // Explicit type so that `nested` can accept an extra `z`.
    type AB = {
      foo: number;
      nested: { x: number; y: number; z?: number };
      keep: string;
      bar?: number;
    };

    const a: AB = {
      foo: 1,
      nested: { x: 1, y: 2 },
      keep: "yes",
    };

    const b: Partial<AB> = {
      nested: { x: 1, y: 3, z: 4 },
      bar: 2,
    };

    const merged = deepMerge<AB>(a, b);
    assertEquals(merged, {
      foo: 1,
      nested: { x: 1, y: 3, z: 4 },
      keep: "yes",
      bar: 2,
    });

    // original should be unchanged (functional style)
    assertEquals(a, {
      foo: 1,
      nested: { x: 1, y: 2 },
      keep: "yes",
    });
  });

  await t.step(
    "mergeData attaches when no existing value, then deep merges on subsequent calls",
    () => {
      // Meta must satisfy T extends Record<string, unknown>
      type Meta = Record<string, unknown> & {
        flags: { a?: boolean; b?: boolean };
      };

      let n = makeNode("paragraph");

      n = mergeData<TestNode, "meta", Meta>(
        n,
        "meta",
        { flags: { a: true } },
      );

      n = mergeData<TestNode, "meta", Meta>(
        n,
        "meta",
        { flags: { b: true } },
      );

      const meta = (n.data as { meta: Meta }).meta;
      assertEquals(meta.flags, { a: true, b: true });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* createDataFactory (unsafe)                                                 */
/* -------------------------------------------------------------------------- */

Deno.test("createDataFactory (unsafe)", async (t) => {
  await t.step("basic attach/get/safeGet/is/collect/forEach/hasAny", () => {
    interface Analysis {
      name: string;
      score: number;
    }

    const analysis: DataFactory<"analysis", Analysis> = nodeDataFactory<
      "analysis",
      Analysis
    >("analysis", { merge: true });

    const n1 = makeNode("paragraph");
    const n2 = analysis.attach(n1, { name: "foo", score: 5 });

    if (analysis.is(n2)) {
      // type narrowing proof
      assert(n2.data.analysis.name);
      assert(n2.data.analysis.score);
    }

    assert(analysis.is(n2));
    const value1 = analysis.get(n2);
    const value2 = analysis.safeGet(n2); // same as get() for unsafe factory
    assertEquals(value1, { name: "foo", score: 5 });
    assertEquals(value2, { name: "foo", score: 5 });

    const tree = makeRoot([
      n2,
      makeNode("paragraph"),
      (() => {
        const h = makeNode("heading");
        h.data = { analysis: { name: "bar", score: 10 } as Analysis };
        return h;
      })(),
    ]);

    const all = analysis.collect(tree);
    assertEquals(all, [
      { name: "foo", score: 5 },
      { name: "bar", score: 10 },
    ]);

    const seen: string[] = [];
    analysis.forEach(tree, (v) => {
      seen.push(v.name);
    });
    seen.sort();
    assertEquals(seen, ["bar", "foo"]);

    assert(analysis.hasAny(tree));
  });
});

/* -------------------------------------------------------------------------- */
/* createSafeDataFactory (Zod-backed)                                         */
/* -------------------------------------------------------------------------- */

Deno.test("createSafeDataFactory (Zod-backed, get vs safeGet + issues)", async (t) => {
  await t.step(
    "valid data attaches; get and safeGet both return parsed data; no issues",
    () => {
      interface Analysis {
        name: string;
        score: number;
      }

      const zAnalysis = z.object({
        name: z.string(),
        score: z.number(),
      });

      const issuesFactory = nodeErrors("issues");

      const analysis = safeNodeDataFactory<"analysis", Analysis>(
        "analysis",
        zAnalysis,
        {
          merge: true,

          onAttachSafeParseError: ({ error, node, attemptedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              phase: "attach",
              attemptedValue,
            });
            return null;
          },

          onSafeGetSafeParseError: ({ error, node, storedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              phase: "safeGet",
              storedValue,
            });
            return null;
          },
        },
      );

      const n1 = makeNode("paragraph");
      const n2 = analysis.attach(n1, { name: "foo", score: 5 });

      const raw = analysis.get(n2);
      const safe = analysis.safeGet(n2);
      assertEquals(raw, { name: "foo", score: 5 });
      assertEquals(safe, { name: "foo", score: 5 });

      const issues = issuesFactory.get(n2);
      assertEquals(issues.length, 0);
    },
  );

  await t.step(
    "invalid data does not throw; issuesFactory stores errors; safeGet returns undefined",
    () => {
      interface Analysis {
        name: string;
        score: number;
      }

      const zAnalysis = z.object({
        name: z.string(),
        score: z.number(),
      });

      const issuesFactory = nodeErrors("issues");

      const analysis = safeNodeDataFactory<"analysis", Analysis>(
        "analysis",
        zAnalysis,
        {
          merge: true,
          onAttachSafeParseError: ({ error, node, attemptedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              phase: "attach",
              attemptedValue,
            });
            return null; // do not store anything
          },
          onSafeGetSafeParseError: ({ error, node, storedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              phase: "safeGet",
              storedValue,
            });
            return null; // do not provide replacement
          },
        },
      );

      const n1 = makeNode("paragraph");
      // score is invalid on purpose
      const n2 = analysis.attach(
        n1,
        { name: "bad", score: "NaN" as unknown as number },
      );

      // Because attach failed validation and handler returned null, nothing stored
      const raw = analysis.get(n2);
      const safe = analysis.safeGet(n2);
      assertEquals(raw, undefined);
      assertEquals(safe, undefined);

      const issues = issuesFactory.get(n2);
      assert(issues.length > 0);
      assertEquals(issues[0].severity, "error");
      assertEquals(issues[0].phase, "attach");
    },
  );
});

/* -------------------------------------------------------------------------- */
/* createArrayDataFactory (unsafe)                                            */
/* -------------------------------------------------------------------------- */

Deno.test("createArrayDataFactory (unsafe)", async (t) => {
  await t.step("basic add/get/safeGet/is/collect/forEach/hasAny", () => {
    const tags: ArrayDataFactory<"tags", string> = nodeArrayDataFactory<
      "tags",
      string
    >("tags");

    const n1 = makeNode("paragraph");
    const n2 = tags.add(n1, "a", "b");

    assert(tags.is(n2));
    const value1 = tags.get(n2);
    const value2 = tags.safeGet(n2);
    assertEquals(value1, ["a", "b"]);
    assertEquals(value2, ["a", "b"]);

    const tree = makeRoot([
      n2,
      makeNode("paragraph"),
      (() => {
        const h = makeNode("heading");
        h.data = { tags: ["c"] as string[] };
        return h;
      })(),
    ]);

    const all = tags.collect(tree);
    assertEquals([...all].sort(), ["a", "b", "c"]);

    const seen: string[] = [];
    tags.forEach(tree, (v) => {
      seen.push(v);
    });
    seen.sort();
    assertEquals(seen, ["a", "b", "c"]);

    assert(tags.hasAny(tree));
  });
});

/* -------------------------------------------------------------------------- */
/* createSafeArrayDataFactory (Zod-backed)                                    */
/* -------------------------------------------------------------------------- */

Deno.test("createSafeArrayDataFactory (Zod-backed, get vs safeGet + issues)", async (t) => {
  await t.step("valid items attach and can be read; no issues recorded", () => {
    const zTag = z.string().min(1);

    const issuesFactory = nodeErrors("issues");

    const tags = safeNodeArrayDataFactory<"tags", string>(
      "tags",
      zTag,
      {
        merge: true,
        onAddSafeParseError: ({ error, node, attemptedItems }) => {
          issuesFactory.add(node, {
            severity: "error",
            message: error.message,
            phase: "add",
            attemptedItems,
          });
          return null;
        },
        onSafeGetSafeParseError: ({ error, node, storedValue }) => {
          issuesFactory.add(node, {
            severity: "error",
            message: error.message,
            phase: "safeGet",
            storedValue,
          });
          return null;
        },
      },
    );

    const n1 = makeNode("paragraph");
    const n2 = tags.add(n1, "alpha", "beta");

    const raw = tags.get(n2);
    const safe = tags.safeGet(n2);
    const rawSorted = [...raw].sort();
    const safeSorted = [...safe].sort();
    assertEquals(rawSorted, ["alpha", "beta"]);
    assertEquals(safeSorted, ["alpha", "beta"]);

    const issues = issuesFactory.get(n2);
    assertEquals(issues.length, 0);
  });

  await t.step(
    "invalid items do not throw; issuesFactory stores errors; safeGet returns []",
    () => {
      const zTag = z.string().min(2);

      const issuesFactory = nodeErrors("issues");

      const tags = safeNodeArrayDataFactory<"tags", string>(
        "tags",
        zTag,
        {
          merge: true,
          onAddSafeParseError: ({ error, node, attemptedItems }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              phase: "add",
              attemptedItems,
            });
            return null; // do not store
          },
          onSafeGetSafeParseError: ({ error, node, storedValue }) => {
            issuesFactory.add(node, {
              severity: "error",
              message: error.message,
              phase: "safeGet",
              storedValue,
            });
            return null; // no replacement
          },
        },
      );

      const n1 = makeNode("paragraph");
      // "x" is invalid (too short)
      const n2 = tags.add(n1, "x");

      const raw = tags.get(n2);
      const safe = tags.safeGet(n2);
      assertEquals(raw, []); // nothing stored
      assertEquals(safe, []); // nothing stored, no replacement

      const issues = issuesFactory.get(n2);
      assert(issues.length > 0);
      assertEquals(issues[0].severity, "error");
      assertEquals(issues[0].phase, "add");
    },
  );
});
