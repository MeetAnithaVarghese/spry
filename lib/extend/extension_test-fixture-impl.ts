/**
 * @module lib/extend/extension_test-fixture-impl
 *
 * Test fixtures for implementations.
 *
 * - Each exported `*Impl` is produced via callable(defn, impl), not by exporting raw functions. This ensures
 *   the exported function object is the Zod-wrapped implementation that performs runtime validation and is
 *   eligible for discovery (via the WeakMap-based impl metadata).
 * - `minimalOnLoadedImpl` uses `void ctx.file` as a deliberate “use” of the value without doing work, to
 *   keep the implementation semantically minimal while still type-checking and exercising the schema.
 * - `explodeImpl` throws to verify error propagation behavior and that discovery does not depend on calling
 *   functions successfully.
 */
import { callable } from "./extension.ts";
import {
  add,
  explode,
  minimalOnLoaded,
} from "./extension_test-fixture-defn.ts";

export const addImpl = callable(add, (a, b) => a + b);

export const minimalOnLoadedImpl = callable(minimalOnLoaded, (ctx) => {
  void ctx.file;
});

export const explodeImpl = callable(explode, (_msg) => {
  throw new Error("boom");
});
