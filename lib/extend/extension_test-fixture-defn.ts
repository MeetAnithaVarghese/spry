/**
 * @module lib/extend/extension_test-fixture-defn
 *
 * Test fixtures that intentionally exercise two different authoring styles:
 *
 * - `plainZodFn` is a deliberately “unregistered” z.function() export. The scan logic should auto-register it
 *   using the export name as the callable id. This verifies that “export a schema” works without explicit
 *   helper calls.
 * - The remaining exports use callableDefn() to create explicit, stable ids (e.g. "spry.math.add") that
 *   remain decoupled from symbol names and module paths, which matters for refactors and multi-module
 *   aggregation.
 * - `explode` returns z.never() to validate that throwing behavior is treated as a valid runtime outcome
 *   (it should never successfully return) and to ensure discovery still includes such callables.
 */
import * as z from "@zod/zod";
import { callableDefn } from "./extension.ts";

/**
 * Plain exported z.function() (NOT created via callableDefn).
 * scanCallables() should auto-tag this as a CallableDefn with id = export name.
 */
export const plainZodFn = z.function({
  input: [z.number(), z.number()],
  output: z.number(),
});

export const add = callableDefn(
  "spry.math.add",
  { input: [z.number(), z.number()], output: z.number() },
);

export const MinimalCtxSchema = z.object({ file: z.string() });

export const minimalOnLoaded = callableDefn(
  "spry.playbook.minimalOnLoaded",
  { input: [MinimalCtxSchema], output: z.void() },
);

export const explode = callableDefn(
  "spry.test.explode",
  { input: [z.string()], output: z.never() },
);
