// lib/universal/data-bag_test.ts
import {
  assert,
  assertEquals,
  assertFalse,
  assertStrictEquals,
} from "@std/assert";
import { dataBag } from "./data-bag.ts";

Deno.test("dataBag factory behavior", async (t) => {
  interface N {
    data?: unknown;
  }

  await t.step("attach() sets a typed value", () => {
    const bag = dataBag<"foo", number, N>("foo");
    const node: N = {};

    bag.attach(node, 42);
    assert(node.data && typeof node.data === "object");

    const record = node.data as Record<string, unknown>;
    assertStrictEquals(record.foo, 42);
  });

  await t.step("is() without onInit returns false when missing", () => {
    const bag = dataBag<"flag", boolean, N>("flag");
    const node: N = {};

    assertFalse(bag.is(node));
  });

  await t.step("is() with onInit initializes when missing", () => {
    const bag = dataBag<"cfg", { a: number }, N>(
      "cfg",
      () => ({ a: 1 }),
    );

    const node: N = {};

    const first = bag.is(node); // should initialize
    assert(first);

    const record = node.data as Record<string, unknown>;
    assertEquals(record.cfg, { a: 1 });

    // is() again should still be true, and not re-init
    record.cfg = { a: 99 };
    const second = bag.is(node);
    assert(second);

    assertEquals(record.cfg, { a: 99 });
  });
});
