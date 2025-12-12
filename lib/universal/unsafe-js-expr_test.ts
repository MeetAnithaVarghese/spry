// unsafe-js-expr_test.ts
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { unsafeJsExpr } from "./unsafe-js-expr.ts";

Deno.test("unsafeJsExpr", async (t) => {
  await t.step("evaluates simple expression with locals", async () => {
    const fn = unsafeJsExpr("a + b", "ctx", ["a", "b"]);
    const result = await fn({}, { a: 2, b: 3 });
    assertEquals(result, 5);
  });

  await t.step("exposes ctx via ctxName", async () => {
    const fn = unsafeJsExpr("ctx.userId", "ctx", []);
    const result = await fn({ userId: "u-123" }, {});
    assertEquals(result, "u-123");
  });

  await t.step("missing locals become undefined", async () => {
    const fn = unsafeJsExpr("a === undefined", "ctx", ["a"]);
    const result = await fn({}, {}); // no "a" in locals
    assertEquals(result, true);
  });

  await t.step("throws if ctxName collides with local key", () => {
    assertThrows(
      () => unsafeJsExpr("ctx + 1", "ctx", ["ctx"]),
      Error,
      `Local key "ctx" conflicts with ctxName`,
    );
  });

  await t.step("throws on invalid local identifier name", () => {
    // "1bad" is not a valid JS identifier
    assertThrows(
      () => unsafeJsExpr("a + 1", "ctx", ["1bad"]),
      Error,
      `Invalid local key "1bad"`,
    );
  });

  await t.step("propagates runtime errors from expression", async () => {
    const fn = unsafeJsExpr("a.b.c()", "ctx", ["a"]);
    await assertRejects(
      () => fn({}, { a: {} }),
      Error,
    );
  });

  await t.step("can use multiple locals and ctx together", async () => {
    const fn = unsafeJsExpr("ctx.multiplier * (a + b)", "ctx", ["a", "b"]);
    const result = await fn({ multiplier: 10 }, { a: 1, b: 2 });
    assertEquals(result, 30);
  });
});
