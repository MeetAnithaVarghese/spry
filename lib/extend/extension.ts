// lib/extend/extension.ts
/**
 * Spry Callable Extensions (Zod v4-native, registry-free)
 *
 * Overview
 * Spry “callables” are just normal JavaScript functions whose inputs and outputs are validated
 * at runtime by Zod v4. The only extra convention is that each callable has a stable string id,
 * so hosts can discover and execute callables by id without coupling to symbol names or module paths.
 *
 * Core idea
 * - A callable definition (defn) is a Zod function schema created by `z.function({ input, output })`.
 * - A callable implementation (impl) is the function produced by `defn.implement(implFn)` which
 *   wraps your implementation with Zod runtime validation.
 * - We attach metadata to both defns and impls using WeakMaps:
 *   - defn metadata: { id, name? } keyed by the Zod schema object
 *   - impl metadata:  { id, name? } keyed by the wrapped function object
 *
 * Why no registries?
 * Spry’s primary operational need is: “discover implementations and execute them by id”.
 * Registries are useful for schema indexing, but they add coupling and bookkeeping. In practice,
 * execution routing is based on implementations, not schemas. So this module keeps indexing optional
 * via `scanDefns()` and keeps execution first-class via `scanCallables()` and `call()`.
 *
 * Authoring pattern
 * 1) In a definitions module:
 *    - Prefer explicit ids via `callableDefn("spry.math.add", { input, output })`.
 *    - If you export a plain `z.function(...)` schema, it is not automatically tagged until
 *      a host calls `scanDefns(exports)`, which can auto-tag using the export name.
 *
 * 2) In an implementations module:
 *    - Export wrapped implementations created by `callable(defn, implFn)`.
 *    - Do not export raw functions if you want discovery and routing by id; discovery is based
 *      on wrapped implementations.
 *
 * Host responsibilities
 * - Discovery for execution:
 *   - Call `scanCallables(moduleExports)` or `call(moduleExports, requests)` directly.
 * - Optional schema indexing:
 *   - Call `scanDefns(moduleExports)` to build an id->defn map (useful for tooling, docs, UIs,
 *     or host-side dynamic wrapping).
 *
 * Execution model
 * `call(exports, requests)`:
 * - Scans exports for callable implementations (wrapped functions).
 * - Builds an id -> implementation map (with configurable duplicate handling).
 * - Executes each request’s args through the wrapped function:
 *   - Input validation happens before your implementation body.
 *   - Output validation happens after your implementation returns.
 * - Returns a per-request result record (ok/value or ok=false/error).
 *
 * Learning path
 * This file is intentionally small and pragmatic. The tests in `extension_test.ts` are the best
 * reference for the scanning, discovery, and execution behaviors, and are intended to serve as
 * executable documentation.
 */

import * as z from "@zod/zod";

// deno-lint-ignore no-explicit-any
type Any = any;

export type CallableId = string;

export type CallableDefnMeta = Readonly<{
  kind: "callableDefn";
  id: CallableId;
  name?: string;
}>;

export type CallableImplMeta = Readonly<{
  kind: "callableImpl";
  id: CallableId;
  name?: string;
}>;

export type CallableDefn<
  I extends readonly z.ZodTypeAny[],
  O extends z.ZodTypeAny,
> = z.ZodFunction<z.ZodTuple<readonly [...I], null>, O>;

type ArgsFromSchemas<I extends readonly z.ZodTypeAny[]> = {
  [K in keyof I]: z.infer<I[K]>;
};

type RetFromSchema<O extends z.ZodTypeAny> = z.infer<O>;

export type CallableFn<
  I extends readonly z.ZodTypeAny[],
  O extends z.ZodTypeAny,
> = (...args: ArgsFromSchemas<I>) => RetFromSchema<O>;

export type CallableImpl<
  I extends readonly z.ZodTypeAny[],
  O extends z.ZodTypeAny,
> = CallableFn<I, O> & {
  readonly __exportName__?: string;
  readonly __moduleSpecifier__?: string;
};

// deno-lint-ignore no-explicit-any
type AnyZodFn = z.ZodFunction<any, any>;
type AnyFn = (...args: readonly unknown[]) => unknown;

/**
 * Callable definition metadata store.
 * Keyed by the Zod function schema object (a stable identity at runtime).
 */
const defnMeta = new WeakMap<AnyZodFn, CallableDefnMeta>();

/**
 * Callable implementation metadata store.
 * Keyed by the wrapped implementation function returned by defn.implement(...).
 */
const implMeta = new WeakMap<AnyFn, CallableImplMeta>();

function isZodFunctionSchema(v: unknown): v is AnyZodFn {
  if (!v || typeof v !== "object") return false;
  const any = v as Any;
  return typeof any.implement === "function" &&
    typeof any.implementAsync === "function";
}

/**
 * True if the value is a Zod function schema that has been tagged as a callable definition.
 */
export function isCallableDefn(v: unknown): v is AnyZodFn {
  return isZodFunctionSchema(v) && defnMeta.has(v);
}

/**
 * Return callable metadata for a definition schema (throws if missing).
 */
export function getCallableDefnMeta(defn: AnyZodFn): CallableDefnMeta {
  const meta = defnMeta.get(defn);
  if (!meta) throw new Error("CallableDefn meta missing");
  return meta;
}

function setCallableDefnMeta(defn: AnyZodFn, meta: CallableDefnMeta): void {
  defnMeta.set(defn, meta);
}

/**
 * Create a callable definition (Zod function schema) and stamp callable metadata on it.
 *
 * Use this for stable ids that are decoupled from export names and module paths.
 */
export function callableDefn<
  const I extends readonly z.ZodTypeAny[],
  O extends z.ZodTypeAny,
>(
  id: CallableId,
  def: Readonly<{ input: readonly [...I]; output: O }>,
  opts: Readonly<{ name?: string }> = {},
): CallableDefn<I, O> {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("callableDefn: id must be a non-empty string");
  }

  const schema = z.function({
    input: [...def.input],
    output: def.output,
  }) as unknown as CallableDefn<I, O>;

  setCallableDefnMeta(schema as unknown as AnyZodFn, {
    kind: "callableDefn",
    id,
    name: opts.name,
  });

  return schema;
}

/**
 * Wrap an implementation function with Zod runtime validation (input + output),
 * and attach callable implementation metadata derived from the definition.
 *
 * The definition must already be tagged (via callableDefn() or scanDefns()) so the id exists.
 */
export function callable<
  I extends readonly z.ZodTypeAny[],
  O extends z.ZodTypeAny,
>(
  defn: CallableDefn<I, O>,
  impl: CallableFn<I, O>,
  opts: Readonly<{ name?: string }> = {},
): CallableImpl<I, O> {
  const meta = defnMeta.get(defn as unknown as AnyZodFn);
  if (!meta) {
    throw new Error(
      "callable: defn has no callable metadata; create via callableDefn() or tag via scanDefns()",
    );
  }

  const wrapped = (defn as Any).implement(impl) as CallableImpl<I, O>;

  implMeta.set(wrapped as unknown as AnyFn, {
    kind: "callableImpl",
    id: meta.id,
    name: opts.name ?? meta.name,
  });

  return wrapped;
}

/**
 * True if the value is a wrapped callable implementation produced by callable(defn, impl).
 */
export function isCallableImpl(
  v: unknown,
): v is CallableImpl<readonly z.ZodTypeAny[], z.ZodTypeAny> {
  return typeof v === "function" && implMeta.has(v as unknown as AnyFn);
}

/**
 * Get callable metadata for a wrapped implementation, if present.
 */
export function getCallableImplMeta(
  fn: CallableImpl<readonly z.ZodTypeAny[], z.ZodTypeAny>,
): CallableImplMeta | undefined {
  return implMeta.get(fn as unknown as AnyFn);
}

function entriesOf(module: unknown): ReadonlyArray<[string, unknown]> {
  if (!module || (typeof module !== "object" && typeof module !== "function")) {
    return [];
  }
  try {
    return Object.entries(module as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * Scan module exports to build an id -> defn index (Map).
 *
 * This is optional, but useful for:
 * - tooling (docs/UI generation, introspection)
 * - host-side dynamic wrapping of defs found by id
 *
 * Auto-tagging behavior:
 * - Any exported Zod function schema that is not yet tagged is stamped using:
 *   id = exportName, name = exportName (unless mapping callbacks override).
 */
export function scanDefns(
  candidates: Record<string, unknown>,
  opts: Readonly<{
    exportNameFilter?: (n: string) => boolean;

    callableIdFromFunc?: (
      exportName: string,
      fn: AnyZodFn,
    ) => CallableId;

    callableNameFromFunc?: (
      exportName: string,
      fn: AnyZodFn,
    ) => string | undefined;
  }> = {},
): ReadonlyMap<CallableId, AnyZodFn> {
  const filter = opts.exportNameFilter ?? (() => true);

  const callableIdFromFunc = opts.callableIdFromFunc ??
    ((exportName) => exportName);
  const callableNameFromFunc = opts.callableNameFromFunc ??
    ((exportName) => exportName);

  const index = new Map<CallableId, AnyZodFn>();

  for (const [exportName, value] of entriesOf(candidates)) {
    if (exportName === "default") continue;
    if (!filter(exportName)) continue;

    if (!isZodFunctionSchema(value)) continue;

    const defn = value as AnyZodFn;

    if (!defnMeta.has(defn)) {
      const id = callableIdFromFunc(exportName, defn);
      if (typeof id === "string" && id.trim().length > 0) {
        setCallableDefnMeta(defn, {
          kind: "callableDefn",
          id,
          name: callableNameFromFunc(exportName, defn),
        });
      }
    }

    if (defnMeta.has(defn)) {
      const meta = getCallableDefnMeta(defn);
      index.set(meta.id, defn);
    }
  }

  return index;
}

export type DiscoveredCallable = Readonly<{
  impl: CallableImpl<readonly z.ZodTypeAny[], z.ZodTypeAny>;
  meta: CallableImplMeta;
  provenance: Readonly<{ moduleSpecifier?: string; exportName: string }>;
}>;

/**
 * Discover callable implementations from module exports.
 *
 * Only wrapped implementations created via callable(defn, impl) are discoverable,
 * because discovery relies on implementation metadata stored in a WeakMap.
 */
export function scanCallables(
  candidates: Record<string, unknown>,
  opts: Readonly<{
    moduleSpecifier?: string;
    exportNameFilter?: (n: string) => boolean;
  }> = {},
): ReadonlyArray<DiscoveredCallable> {
  const out: DiscoveredCallable[] = [];
  const filter = opts.exportNameFilter ?? (() => true);

  for (const [exportName, value] of entriesOf(candidates)) {
    if (exportName === "default") continue;
    if (!filter(exportName)) continue;

    if (!isCallableImpl(value)) continue;

    const impl = value;
    const meta = getCallableImplMeta(impl);
    if (!meta) continue;

    try {
      Object.defineProperty(impl as Any, "__exportName__", {
        value: exportName,
      });
      Object.defineProperty(impl as Any, "__moduleSpecifier__", {
        value: opts.moduleSpecifier,
      });
    } catch {
      // ignore
    }

    out.push({
      impl,
      meta,
      provenance: { moduleSpecifier: opts.moduleSpecifier, exportName },
    });
  }

  return out;
}

/**
 * Convenience helper to import a module (or accept an already-imported exports object)
 * and discover callable implementations from it.
 */
export async function loadCallablesFrom(
  modOrSpecifier: Record<string, unknown> | string | URL,
  opts: Readonly<{ moduleSpecifier?: string }> = {},
): Promise<ReadonlyArray<DiscoveredCallable>> {
  const mod =
    (typeof modOrSpecifier === "string" || modOrSpecifier instanceof URL)
      ? (await import(String(modOrSpecifier))) as Record<string, unknown>
      : modOrSpecifier;

  return scanCallables(mod, { moduleSpecifier: opts.moduleSpecifier });
}

/**
 * Request to call a callable by id, or by a defn schema (id derived from defn meta).
 */
export type CallRequest =
  | Readonly<{ id: CallableId; args: readonly unknown[] }>
  | Readonly<{ defn: AnyZodFn; args: readonly unknown[] }>;

/**
 * Per-call result. Errors are captured so callers can batch-run many calls.
 */
export type CallResult = Readonly<
  | { id: CallableId; ok: true; value: unknown }
  | { id: CallableId; ok: false; error: unknown }
>;

/**
 * Execute discovered implementations by id.
 *
 * Steps:
 * - Scan module exports for callable implementations (wrapped functions).
 * - Route each request by id to a discovered implementation.
 * - Execute and return { ok: true, value } or { ok: false, error }.
 *
 * Duplicate ids:
 * - "last" (default): last discovered wins
 * - "first": first discovered wins
 * - "error": any duplicate causes an error for requests targeting that id
 */
export async function call(
  candidates: Record<string, unknown>,
  requests: readonly CallRequest[],
  opts: Readonly<{
    moduleSpecifier?: string;
    exportNameFilter?: (n: string) => boolean;
    onDuplicateImpl?: "first" | "last" | "error";
  }> = {},
): Promise<ReadonlyArray<CallResult>> {
  const discovered = scanCallables(candidates, {
    moduleSpecifier: opts.moduleSpecifier,
    exportNameFilter: opts.exportNameFilter,
  });

  const onDup = opts.onDuplicateImpl ?? "last";

  const implById = new Map<CallableId, DiscoveredCallable>();
  const dups = new Set<CallableId>();

  for (const d of discovered) {
    const existing = implById.get(d.meta.id);
    if (!existing) {
      implById.set(d.meta.id, d);
      continue;
    }
    dups.add(d.meta.id);
    if (onDup === "first") continue;
    if (onDup === "last") implById.set(d.meta.id, d);
  }

  const results: CallResult[] = [];

  for (const req of requests) {
    const id = "id" in req ? req.id : getCallableDefnMeta(req.defn).id;

    try {
      if (onDup === "error" && dups.has(id)) {
        throw new Error(
          `Multiple callable implementations discovered for id '${id}'`,
        );
      }

      const found = implById.get(id);
      if (!found) {
        throw new Error(`No callable implementation discovered for id '${id}'`);
      }

      const value = (found.impl as (...a: unknown[]) => unknown)(...req.args);
      const awaited = value instanceof Promise ? await value : value;

      results.push({ id, ok: true, value: awaited });
    } catch (error) {
      results.push({ id, ok: false, error });
    }
  }

  return results;
}
