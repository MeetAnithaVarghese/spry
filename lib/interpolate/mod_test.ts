// lib/interpolate/mod_test.ts
//
// Integration-style tests for Spry Text Interpolation.
//
// These tests are intentionally "story-like" and heavily commented so that
// juniors can read them as executable documentation for how partials,
// unsafe interpolation, and capture work together (similar to runbooks).
//
// They exercise:
//   - partialContent + PartialCollection
//   - unsafeInterpFactory (dynamic JS-based interpolation)
//   - captureFactory (capturing interpolated output for later use)

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { type Captured, captureFactory, type CaptureSpec } from "./capture.ts";
import {
  type PartialCollection,
  partialContent,
  partialContentCollection,
} from "./partial.ts";
import {
  unsafeInterpFactory,
  type UnsafeInterpolationResult,
} from "./unsafe.ts";

Deno.test("Spry Text Interpolation – end-to-end examples", async (t) => {
  // ---------------------------------------------------------------------------
  // 1. Simple partial + unsafe interpolation (no capture)
  // ---------------------------------------------------------------------------
  await t.step("simple partial + unsafe interpolation", async () => {
    type FragmentLocals = Record<string, unknown>;

    const partials: PartialCollection<FragmentLocals> =
      partialContentCollection<FragmentLocals>();

    partials.register(
      partialContent<FragmentLocals>(
        "hello",
        `echo "Hello \${name}!"`,
        undefined,
        {
          schemaSpec: {
            name: { type: "string", required: true },
          },
        },
      ),
    );

    const { interpolateUnsafely } = unsafeInterpFactory<{
      readonly taskId: string;
    }>({
      partialsCollec: partials as PartialCollection<Record<string, unknown>>,
      interpCtx: () => ({}),
    });

    const source = [
      "#!/usr/bin/env -S bash",
      'Top: ${await partial("hello", { name: "Zoya" })}',
    ].join("\n");

    const result = await interpolateUnsafely({
      taskId: "demo-simple-partial",
      source,
      interpolate: true,
    });

    assertEquals(result.status, "mutated");
    assertStringIncludes(result.source, 'Top: echo "Hello Zoya!"');
  });

  // ---------------------------------------------------------------------------
  // 2. Integration with captureFactory + "captured" history
  // ---------------------------------------------------------------------------
  await t.step(
    "unsafe interpolation + captureFactory + captured history",
    async () => {
      type Task = {
        readonly id: string;
        readonly value: string;
        readonly args: {
          readonly interpolate: boolean;
          readonly capture: CaptureSpec[];
        };
      };

      const cf = captureFactory<
        Task,
        { readonly interpResult: UnsafeInterpolationResult }
      >(
        {
          isCapturable: (ctx, _op) =>
            ctx.args.capture.length ? ctx.args.capture : false,
          prepareCaptured: (op, ctx) =>
            ({
              text: () => op.interpResult.source,
              json: () => ({
                taskId: ctx.id,
                content: op.interpResult.source,
              }),
            }) satisfies Captured,
        },
      );

      const { history: captured, capture } = cf;

      const partials = partialContentCollection<Record<string, unknown>>();

      const { interpolateUnsafely } = unsafeInterpFactory<Task>({
        partialsCollec: partials,
        // Expose captured history via default context; templates can do:
        // `${captured["step1"].text()}`
        interpCtx: () => ({ captured }),
      });

      const taskA: Task = {
        id: "step-1",
        // IMPORTANT: this must be a *plain string* with `${40 + 2}` inside,
        // so the unsafe interpolator sees it and evaluates the expression.
        value: "A: ${40 + 2}",
        args: {
          interpolate: true,
          capture: [{ nature: "memory", key: "step1" }],
        },
      };

      const taskB: Task = {
        id: "step-2",
        // Same idea: keep `${captured[...]}` as literal text, not a TS template.
        value:
          'B from capture: ${captured["step1"] ? captured["step1"].text() : "MISSING"}',
        args: {
          interpolate: true,
          capture: [{ nature: "memory", key: "step2" }],
        },
      };

      // Interpolate A, then capture.
      const interpA = await interpolateUnsafely({
        ...taskA,
        source: taskA.value,
        interpolate: taskA.args.interpolate,
      });
      assertEquals(interpA.status, "mutated");
      assertStringIncludes(interpA.source, "A: 42");

      await capture(taskA, { interpResult: interpA });
      assert("step1" in captured);
      assertStringIncludes(captured["step1"].text(), "A: 42");

      // Now interpolate B, which references captured["step1"].
      const interpB = await interpolateUnsafely({
        ...taskB,
        source: taskB.value,
        interpolate: taskB.args.interpolate,
      });
      await capture(taskB, { interpResult: interpB });

      assertEquals(interpB.status, "mutated");
      assertStringIncludes(interpB.source, "B from capture: A: 42");
      assert("step2" in captured);
      assertStringIncludes(captured["step2"].text(), "B from capture: A: 42");
    },
  );

  // ---------------------------------------------------------------------------
  // 3. Partial injection/wrapping via PartialCollection.compose
  // ---------------------------------------------------------------------------
  await t.step("partial injection / wrapping with compose()", async () => {
    type BodyLocals = { message: string };

    const partials = partialContentCollection<BodyLocals>();

    partials.register(
      partialContent<BodyLocals>(
        "body",
        "INNER-CONTENT",
        undefined,
      ),
    );

    partials.register(
      partialContent<BodyLocals>(
        "wrapper",
        "BEGIN-WRAP\n${content}\nEND-WRAP",
        undefined,
        {
          inject: {
            globs: ["**/*.txt"],
            prepend: true,
            append: true,
          },
        },
      ),
    );

    const plainBody = await partials
      .get("body")!
      .content({ message: "ignored for now" });
    assertEquals(plainBody.interpolate, true);
    assertEquals(plainBody.content, "INNER-CONTENT");

    const composed = await partials.compose(plainBody, {
      path: "foo/bar/generated.txt",
    });

    assertEquals(composed.interpolate, plainBody.interpolate);
    assertStringIncludes(composed.content, "BEGIN-WRAP");
    assertStringIncludes(composed.content, "INNER-CONTENT");
    assertStringIncludes(composed.content, "END-WRAP");
  });
});
