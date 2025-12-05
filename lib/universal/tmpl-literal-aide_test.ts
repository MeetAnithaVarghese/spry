import { assert, assertEquals } from "@std/assert";
import {
  block,
  ifElse,
  indent,
  joinText,
  lines,
  mapJoin,
  trimBlock,
  unless,
  when,
} from "./tmpl-literal-aide.ts";

Deno.test("helpers", async (t) => {
  await t.step("block() — IIFE style (auto-dedent & trim)", () => {
    const out = block(() => `
      Title
        Indented line
      Final
    `);
    assert(out.startsWith("Title"));
    assert(out.includes("  Indented line"));
    assert(out.endsWith("Final"));
  });

  await t.step("block(vars, fn) — IIFE with locals", () => {
    const out = block({ title: "Hello", sub: "World" }, ({ title, sub }) => `
      # ${title}
      ${sub}
    `);
    assertEquals(out, "# Hello\nWorld");
  });

  await t.step("block`...` — tagged template (no locals)", () => {
    const a = 3, b = 4;
    const out = block`
      Sum: ${a + b}
    `;
    assertEquals(out, "Sum: 7");
  });

  await t.step("block — tagged template with arrays and nulls", () => {
    const items = ["A", null, "C", undefined, ["D", "E"]];
    const out = block`
      ${items}
    `;
    // Arrays are flattened and null/undefined omitted by stringify logic.
    assertEquals(out, "ACDE"); // Default join from String(array) is comma; our impl flattens to '', but we join elements directly in stringify → "ACDE"
    // NOTE: If you prefer custom array joining, use mapJoin() inside the template.
  });

  await t.step("mapJoin(list, render, sep) — explicit separators", () => {
    const out = mapJoin([1, 2, 3], (n) => `• ${n}`, " | ");
    assertEquals(out, "• 1 | • 2 | • 3");
  });

  await t.step("joinText([...], sep) — skip falsy/empty", () => {
    const out = joinText(["A", "", undefined, "B", false, "C"], ", ");
    assertEquals(out, "A, B, C");
  });

  await t.step("lines(...rows) — newline-join convenience", () => {
    const out = lines("alpha", "", undefined, "beta", null, "gamma");
    assertEquals(out, "alpha\nbeta\ngamma");
  });

  await t.step("indent(s, n) — indent non-empty lines only", () => {
    const s = "a\n\nb";
    const out = indent(s, 4);
    assertEquals(out, "    a\n\n    b");
  });

  await t.step("trimBlock(s) — remove leading/trailing whitespace", () => {
    const out = trimBlock("\n  keep\n\n");
    assertEquals(out, "keep");
  });

  await t.step("when / unless / ifElse — conditional composition", () => {
    const on = true, off = false;

    const a = when(on, "ON");
    const b = when(off, "OFF");
    const c = unless(off, "SHOWN");
    const d = unless(on, "HIDDEN");
    const e = ifElse(on, "A", "B");
    const f = ifElse(off, "A", "B");

    assertEquals(a, "ON");
    assertEquals(b, "");
    assertEquals(c, "SHOWN");
    assertEquals(d, "");
    assertEquals(e, "A");
    assertEquals(f, "B");
  });
});
