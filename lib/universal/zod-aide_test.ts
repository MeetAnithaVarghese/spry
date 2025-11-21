// zod-aide_test.ts
//
// Documentation-centric test suite for `jsonToZod` in zod-aide.ts.
// Run: deno test -A lib/universal/zod-aide_test.ts

import { assert, assertEquals, assertThrows } from "@std/assert";
import { z } from "@zod/zod";
import { jsonToZod } from "./zod-aide.ts";

Deno.test("jsonToZod - documentation and behavior", async (t) => {
  await t.step("1) Strings - minLength, maxLength, pattern", () => {
    const src = JSON.stringify({
      type: "string",
      minLength: 2,
      maxLength: 5,
      pattern: "^[A-Z][a-z]+$",
    });
    const S = jsonToZod(src);
    assertEquals(S.parse("Zoya"), "Zoya");
    assertThrows(() => S.parse("zoya"), z.ZodError);
    assertThrows(() => S.parse("Z"), z.ZodError);
    assertThrows(() => S.parse("Zoyaaaa"), z.ZodError);
  });

  await t.step("2) Numbers & Integers - bounds & multiples", () => {
    const num = jsonToZod(JSON.stringify({
      type: "number",
      minimum: 0,
      exclusiveMaximum: 10,
      multipleOf: 0.5,
    }));
    assertEquals(num.parse(9.5), 9.5);
    assertThrows(() => num.parse(10), z.ZodError);
    assertThrows(() => num.parse(-1), z.ZodError);
    assertThrows(() => num.parse(9.3), z.ZodError);

    const int = jsonToZod(JSON.stringify({
      type: "integer",
      minimum: 1,
      maximum: 3,
    }));
    assertEquals(int.parse(2), 2);
    assertThrows(() => int.parse(2.5), z.ZodError);
    assertThrows(() => int.parse(4), z.ZodError);
  });

  await t.step("3) Booleans & Null", () => {
    const B = jsonToZod(JSON.stringify({ type: "boolean" }));
    assertEquals(B.parse(true), true);
    assertThrows(() => B.parse(0), z.ZodError);

    const N = jsonToZod(JSON.stringify({ type: "null" }));
    assertEquals(N.parse(null), null);
    assertThrows(() => N.parse("null"), z.ZodError);
  });

  await t.step("4) Enum - strings only vs mixed-type enum", () => {
    const strEnum = jsonToZod(JSON.stringify({ enum: ["admin", "editor"] }));
    assertEquals(strEnum.parse("admin"), "admin");
    assertThrows(() => strEnum.parse("viewer"), z.ZodError);

    const mixedEnum = jsonToZod(JSON.stringify({ enum: ["ok", 1, null] }));
    assertEquals(mixedEnum.parse("ok"), "ok");
    assertEquals(mixedEnum.parse(1), 1);
    assertEquals(mixedEnum.parse(null), null);
    assertThrows(() => mixedEnum.parse(false), z.ZodError);
  });

  await t.step("5) Const - literal only", () => {
    const C = jsonToZod(JSON.stringify({ const: 42 }));
    assertEquals(C.parse(42), 42);
    assertThrows(() => C.parse(41), z.ZodError);
  });

  await t.step("6) anyOf/oneOf → union, allOf → intersection", () => {
    const U = jsonToZod(JSON.stringify({
      anyOf: [
        { type: "string", minLength: 3 },
        { type: "number", minimum: 0 },
      ],
    }));
    assertEquals(U.parse("abc"), "abc");
    assertEquals(U.parse(10), 10);
    assertThrows(() => U.parse("x"), z.ZodError);
    assertThrows(() => U.parse(-2), z.ZodError);

    const I = jsonToZod(JSON.stringify({
      allOf: [
        { type: "number", minimum: 0 },
        { type: "number", maximum: 10 },
      ],
    }));
    assertEquals(I.parse(5), 5);
    assertThrows(() => I.parse(-1), z.ZodError);
    assertThrows(() => I.parse(11), z.ZodError);
  });

  await t.step('7) type: ["X","Y"] unions and ["X","null"] nullable', () => {
    const U = jsonToZod(JSON.stringify({ type: ["string", "number"] }));
    assertEquals(U.parse("hi"), "hi");
    assertEquals(U.parse(7), 7);
    assertThrows(() => U.parse(true), z.ZodError);

    const Nullable = jsonToZod(JSON.stringify({ type: ["string", "null"] }));
    assertEquals(Nullable.parse("ok"), "ok");
    assertEquals(Nullable.parse(null), null);

    const NullableFlag = jsonToZod(JSON.stringify({
      type: "string",
      nullable: true,
    }));
    assertEquals(NullableFlag.parse("x"), "x");
    assertEquals(NullableFlag.parse(null), null);
  });

  await t.step("8) Arrays - homogeneous items with min/max", () => {
    const A = jsonToZod(JSON.stringify({
      type: "array",
      items: { type: "integer", minimum: 0 },
      minItems: 1,
      maxItems: 3,
    }));
    assertEquals(A.parse([1, 2, 3]), [1, 2, 3]);
    assertThrows(() => A.parse([]), z.ZodError);
    assertThrows(() => A.parse([1, 2, 3, 4]), z.ZodError);
    assertThrows(() => A.parse([1, -1]), z.ZodError);
  });

  await t.step("9) Arrays - tuple via items: [...] (fixed length)", () => {
    const T = jsonToZod(JSON.stringify({
      type: "array",
      items: [
        { type: "string" },
        { type: "integer" },
        { enum: ["x", "y"] },
      ],
    }));
    assertEquals(T.parse(["z", 2, "x"]), ["z", 2, "x"]);
    assertThrows(() => T.parse(["z", 2]), z.ZodError); // not enough
    assertThrows(() => T.parse(["z", 2, "q"]), z.ZodError); // enum mismatch
  });

  await t.step(
    "10) Objects - per-property required: true + additionalProperties=false",
    () => {
      const O = jsonToZod(JSON.stringify({
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1, required: true }, // <-- per-property required
          name: { type: "string", minLength: 1, required: true }, // <-- per-property required
          email: { type: ["string", "null"] }, // optional by default
        },
        additionalProperties: false,
      }));

      const ok = O.parse({ id: 10, name: "Z", email: null }) as Record<
        string,
        unknown
      >;
      assertEquals(ok.id, 10);
      assertEquals(ok.name, "Z");
      assertEquals(ok.email, null);

      // Missing required props should fail
      assertThrows(() => O.parse({ id: 10 }), z.ZodError);
      assertThrows(() => O.parse({ name: "Z" }), z.ZodError);

      // Extra keys are rejected by .strict()
      assertThrows(
        () => O.parse({ id: 10, name: "Z", extra: true }),
        z.ZodError,
      );
    },
  );

  await t.step(
    "11) Objects - additionalProperties=true (passthrough unknown)",
    () => {
      const O = jsonToZod(JSON.stringify({
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: true,
      }));
      const v = O.parse({ a: "ok", b: 123, c: { d: 1 } }) as Record<
        string,
        unknown
      >;
      assertEquals(v.a, "ok");
      assert("b" in v && "c" in v);
    },
  );

  await t.step(
    "12) Objects - additionalProperties as schema (catchall)",
    () => {
      const O = jsonToZod(JSON.stringify({
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: { type: "integer" },
      }));

      const good = O.parse({ a: "x", b: 10, c: 0 }) as Record<string, unknown>;
      assertEquals(good.b, 10);
      assertThrows(() => O.parse({ a: "x", b: "bad" }), z.ZodError);
    },
  );

  await t.step(
    "13) Type omitted - inferred object or array; else z.any()",
    () => {
      const Obj = jsonToZod(JSON.stringify({
        properties: { x: { type: "string" } },
        required: ["x"],
        additionalProperties: false,
      }));
      const vo = Obj.parse({ x: "ok" }) as Record<string, unknown>;
      assertEquals(vo.x, "ok");

      const Arr = jsonToZod(JSON.stringify({ items: { type: "boolean" } }));
      const va = Arr.parse([true, false]) as unknown[];
      assertEquals(va[1], false);

      const Any = jsonToZod("{}");
      assertEquals(Any.parse(123), 123);
      assertEquals(Any.parse("x"), "x");
    },
  );
});
