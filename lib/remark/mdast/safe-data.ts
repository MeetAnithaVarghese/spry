// safe-data.ts
//
// Generalized, type-safe utilities for attaching arbitrary strongly-typed
// data structures onto mdast/unist nodes, with optional Zod validation.
//
// - Core primitives: ensureData, attachData, getData, isDataSupplier,
//   collectData, forEachData, hasAnyData
// - createDataFactory(): key-based facade (no Zod, optional deep merge)
// - createSafeDataFactory(): Zod-backed, never throws, delegates error
//   handling to callbacks in options; exposes get (raw, optional default)
//   and safeGet (validated on existing data, optional default)
// - createArrayDataFactory(): array-valued facade (no Zod)
// - createSafeArrayDataFactory(): Zod-backed array factory, never throws,
//   delegates error handling to callbacks in options; exposes get/safeGet
//   with optional default.
//
// Merging is controlled by options (merge?: boolean) instead of separate
// factory types.

import { z } from "@zod/zod";
import type { Root } from "types/mdast";
import type { Data, Node } from "types/unist";
import { visit } from "unist-util-visit";

/* -------------------------------------------------------------------------- */
/* Core primitives                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ensure `node.data` exists and return it as mutable Data.
 */
export function ensureData<N extends Node>(node: N): Data {
  const n = node as N & { data?: Data };
  if (!n.data) n.data = {};
  return n.data;
}

/**
 * A node that supplies some named data bag, like:
 *
 *   node.data[key] = T
 */
export type DataSupplierNode<
  N extends Node = Node,
  Key extends string = string,
  T = unknown,
> = N & {
  readonly data: {
    readonly [K in Key]: T;
  };
};

/**
 * Attach strongly typed data under a given key.
 *
 * Returns the same node but typed as DataSupplierNode<N, Key, T>.
 * This overwrites any existing value at `data[key]`.
 */
export function attachData<
  N extends Node,
  Key extends string,
  T,
>(
  node: N,
  key: Key,
  value: T,
): DataSupplierNode<N, Key, T> {
  const data = ensureData(node);
  (data as Record<string, unknown>)[key] = value;
  return node as DataSupplierNode<N, Key, T>;
}

/**
 * Retrieve typed data from a node. Returns undefined if missing.
 *
 * If a Zod schema is supplied, the value is validated before returning.
 * Throws if validation fails.
 *
 * NOTE: This is the low-level primitive and *can* throw; safe factories
 * wrap validation with safeParse and user-provided callbacks instead of
 * throwing.
 */
export function getData<
  T,
  N extends Node,
  Key extends string,
>(
  node: N,
  key: Key,
  schema?: z.ZodType<T>,
): T | undefined {
  const data = (node as { data?: Data }).data;
  if (!data) return undefined;

  const value = (data as Record<string, unknown>)[key] as T | undefined;
  if (value === undefined) return undefined;

  if (schema) {
    return schema.parse(value);
  } else {
    return value;
  }
}

/**
 * Type guard:
 *   isDataSupplier(node, "foo") → node.data.foo exists
 *
 * Allows TS to narrow the node to DataSupplierNode<N, Key, T>.
 */
export function isDataSupplier<
  T = unknown,
  N extends Node = Node,
  Key extends string = string,
>(
  node: N,
  key: Key,
): node is DataSupplierNode<N, Key, T> {
  const data = (node as { data?: Data }).data;
  return !!data && key in data;
}

/**
 * Visit the tree and collect all occurrences of a given data key.
 *
 * Returns array of typed values.
 */
export function collectData<
  T,
  Key extends string,
>(
  root: Root,
  key: Key,
): readonly T[] {
  const out: T[] = [];
  visit(root, (node) => {
    if (isDataSupplier<T>(node, key)) {
      out.push((node.data as Record<Key, T>)[key]);
    }
  });
  return out;
}

/**
 * Iterate all typed data bags in the tree, giving (value, owningNode).
 */
export function forEachData<
  T,
  Key extends string,
>(
  root: Root,
  key: Key,
  fn: (value: T, owner: DataSupplierNode<Node, Key, T>) => void,
): void {
  visit(root, (node) => {
    if (isDataSupplier<T>(node, key)) {
      fn(
        (node.data as Record<Key, T>)[key],
        node as DataSupplierNode<Node, Key, T>,
      );
    }
  });
}

/**
 * True if *any* node in the tree has the specified typed data.
 */
export function hasAnyData<Key extends string>(
  root: Root,
  key: Key,
): boolean {
  let found = false;
  visit(root, (node) => {
    if (found) return;
    if (isDataSupplier(node, key)) found = true;
  });
  return found;
}

/* -------------------------------------------------------------------------- */
/* Deep merge + merging helpers                                               */
/* -------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Simple deep merge for plain objects:
 * - Recursively merges nested plain objects.
 * - For arrays and primitives, source overwrites target.
 */
export function deepMerge<T>(
  target: T,
  source: Partial<T>,
): T {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    // Non-objects: prefer source when defined, otherwise target.
    return (source !== undefined ? source : target) as T;
  }

  const result: Record<string, unknown> = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const existing = result[key];

    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else {
      // Arrays, primitives, etc. → overwrite
      result[key] = value;
    }
  }

  return result as T;
}

/**
 * Merge object-like data under a given key using deepMerge().
 *
 * If there is no existing value, it behaves like attachData().
 */
export function mergeData<
  N extends Node,
  Key extends string,
  T extends Record<string, unknown>,
>(
  node: N,
  key: Key,
  patch: Partial<T>,
): DataSupplierNode<N, Key, T> {
  const data = ensureData(node);
  const existing = (data as Record<string, unknown>)[key] as T | undefined;

  const next = existing ? deepMerge(existing, patch) : (patch as T);
  (data as Record<string, unknown>)[key] = next;
  return node as DataSupplierNode<N, Key, T>;
}

/* -------------------------------------------------------------------------- */
/* Scalar/object Data factories (unsafe, no Zod)                              */
/* -------------------------------------------------------------------------- */

export interface DataFactoryOptions<T> {
  /**
   * If true, attach() will deep-merge new values with existing values when both
   * are plain objects. For non-plain objects, attach() falls back to overwrite.
   */
  merge?: boolean;
}

export interface DataFactory<
  Key extends string,
  T,
> {
  readonly key: Key;

  /**
   * Attach a value (overwriting or merging based on options).
   */
  attach<N extends Node>(node: N, value: T): DataSupplierNode<N, Key, T>;

  /**
   * Raw access: returns whatever is stored under the key (no validation).
   *
   * If `ifNotExists` is provided and the key is absent, it will be called to
   * create a value, which is then attached to the node and returned.
   */
  get<N extends Node>(
    node: N,
    ifNotExists?: (node: N) => T | null | undefined,
  ): T | undefined;

  /**
   * For "unsafe" factories (no schema), safeGet is equivalent to get().
   * Signature is the same for ergonomic symmetry.
   */
  safeGet<N extends Node>(
    node: N,
    ifNotExists?: (node: N) => T | null | undefined,
  ): T | undefined;

  /**
   * Type guard for nodes that have the key set.
   */
  is<N extends Node>(node: N): node is DataSupplierNode<N, Key, T>;

  collect(root: Root): readonly T[];

  /**
   * Like collect(), but returns the owning nodes instead of the values.
   */
  collectNodes<N extends Node>(
    root: Root,
  ): readonly DataSupplierNode<N, Key, T>[];

  forEach(
    root: Root,
    fn: (value: T, owner: DataSupplierNode<Node, Key, T>) => void,
  ): void;

  hasAny(root: Root): boolean;
}

/**
 * Create a data factory bound to a specific key (no Zod validation).
 */
export function nodeDataFactory<
  Key extends string,
  T,
>(
  key: Key,
  options?: DataFactoryOptions<T>,
): DataFactory<Key, T> {
  const mergeEnabled = options?.merge === true;

  return {
    key,

    attach<N extends Node>(node: N, value: T) {
      if (!mergeEnabled) {
        return attachData<N, Key, T>(node, key, value);
      }

      const existing = getData<T, N, Key>(node, key);
      let next: T;

      if (
        existing !== undefined &&
        isPlainObject(existing) &&
        isPlainObject(value)
      ) {
        next = deepMerge(existing, value as Partial<T>);
      } else {
        next = value;
      }

      return attachData<N, Key, T>(node, key, next);
    },

    get<N extends Node>(node: N, ifNotExists?: (node: N) => T): T | undefined {
      const existing = getData<T, N, Key>(node, key);
      if (existing !== undefined) return existing;

      if (!ifNotExists) return undefined;
      const created = ifNotExists(node);
      if (created === undefined) return undefined;
      attachData<N, Key, T>(node, key, created);
      return created;
    },

    safeGet<N extends Node>(
      node: N,
      ifNotExists?: (node: N) => T,
    ): T | undefined {
      // Unsafe factory: safeGet == get
      return this.get(node, ifNotExists);
    },

    is<N extends Node>(node: N): node is DataSupplierNode<N, Key, T> {
      return isDataSupplier<T, N, Key>(node, key);
    },

    collect(root: Root): readonly T[] {
      return collectData<T, Key>(root, key);
    },

    collectNodes<N extends Node>(
      root: Root,
    ): readonly DataSupplierNode<N, Key, T>[] {
      const out: DataSupplierNode<Node, Key, T>[] = [];
      forEachData<T, Key>(root, key, (_value, owner) => {
        out.push(owner as DataSupplierNode<Node, Key, T>);
      });
      return out as DataSupplierNode<N, Key, T>[];
    },

    forEach(
      root: Root,
      fn: (value: T, owner: DataSupplierNode<Node, Key, T>) => void,
    ): void {
      forEachData<T, Key>(root, key, fn);
    },

    hasAny(root: Root): boolean {
      return hasAnyData(root, key);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Array-valued factories (unsafe, no Zod)                                    */
/* -------------------------------------------------------------------------- */

export interface ArrayDataFactoryOptions {
  /**
   * If true (default), add() appends to any existing array.
   * If false, add() replaces the array with the new items.
   */
  merge?: boolean;
}

export interface ArrayDataFactory<
  Key extends string,
  T,
> {
  readonly key: Key;

  // Append or replace items in the per-node array (depending on merge option)
  add<N extends Node>(
    node: N,
    ...items: readonly T[]
  ): DataSupplierNode<N, Key, T[]>;

  /**
   * Raw access: always returns an array (empty if none stored yet).
   *
   * If `ifNotExists` is provided and no array is stored yet, it will be called
   * to create an initial array, which is then attached and returned.
   */
  get<N extends Node>(
    node: N,
    ifNotExists?: (node: N) => T[],
  ): T[];

  /**
   * For "unsafe" factories (no schema), safeGet is equivalent to get().
   */
  safeGet<N extends Node>(
    node: N,
    ifNotExists?: (node: N) => T[],
  ): T[];

  // Type guard for nodes that have an array at this key
  is<N extends Node>(node: N): node is DataSupplierNode<N, Key, T[]>;

  // Flatten all arrays from all nodes into a single array
  collect(root: Root): readonly T[];

  /**
   * Like collect(), but returns the owning nodes (one per node) instead
   * of individual items. Nodes with empty or non-array buckets are skipped.
   */
  collectNodes<N extends Node>(
    root: Root,
  ): readonly DataSupplierNode<N, Key, T[]>[];

  // Visit each individual item together with its owning node
  forEach(
    root: Root,
    fn: (item: T, owner: DataSupplierNode<Node, Key, T[]>) => void,
  ): void;

  // True if any node has a non-empty array for this key
  hasAny(root: Root): boolean;
}

/**
 * Create an array-valued data factory bound to a specific key (no validation).
 */
export function nodeArrayDataFactory<
  Key extends string,
  T,
>(
  key: Key,
  options?: ArrayDataFactoryOptions,
): ArrayDataFactory<Key, T> {
  const merge = options?.merge !== false; // default: true

  return {
    key,

    add<N extends Node>(node: N, ...items: readonly T[]) {
      const existing = merge ? (getData<T[], N, Key>(node, key) ?? []) : [];
      const next = (existing as T[]).concat(items);
      return attachData<N, Key, T[]>(node, key, next);
    },

    get<N extends Node>(
      node: N,
      ifNotExists?: (node: N) => T[],
    ): T[] {
      const existing = getData<T[], N, Key>(node, key);
      if (existing !== undefined) return existing as T[];

      if (!ifNotExists) return [];
      const created = ifNotExists(node);
      if (!created) return [];
      attachData<N, Key, T[]>(node, key, created);
      return created;
    },

    safeGet<N extends Node>(
      node: N,
      ifNotExists?: (node: N) => T[],
    ): T[] {
      // Unsafe factory: safeGet == get
      return this.get(node, ifNotExists);
    },

    is<N extends Node>(node: N): node is DataSupplierNode<N, Key, T[]> {
      return isDataSupplier<T[], N, Key>(node, key);
    },

    collect(root: Root): readonly T[] {
      const buckets = collectData<T[], Key>(root, key);
      const out: T[] = [];
      for (const bucket of buckets) {
        if (Array.isArray(bucket)) out.push(...bucket);
      }
      return out;
    },

    collectNodes<N extends Node>(
      root: Root,
    ): readonly DataSupplierNode<N, Key, T[]>[] {
      const out: DataSupplierNode<Node, Key, T[]>[] = [];
      const seen = new Set<DataSupplierNode<Node, Key, T[]>>();

      forEachData<T[], Key>(root, key, (bucket, owner) => {
        if (!Array.isArray(bucket) || bucket.length === 0) return;

        const typedOwner = owner as DataSupplierNode<Node, Key, T[]>;
        if (seen.has(typedOwner)) return;

        seen.add(typedOwner);
        out.push(typedOwner);
      });

      return out as DataSupplierNode<N, Key, T[]>[];
    },

    forEach(
      root: Root,
      fn: (item: T, owner: DataSupplierNode<Node, Key, T[]>) => void,
    ): void {
      forEachData<T[], Key>(root, key, (bucket, owner) => {
        if (!Array.isArray(bucket)) return;
        for (const item of bucket) {
          fn(item, owner as DataSupplierNode<Node, Key, T[]>);
        }
      });
    },

    hasAny(root: Root): boolean {
      // We only care if any bucket is non-empty
      let found = false;
      forEachData<T[], Key>(root, key, (bucket) => {
        if (!found && Array.isArray(bucket) && bucket.length > 0) {
          found = true;
        }
      });
      return found;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Safe factories (Zod-backed, callback-driven error handling)                */
/* -------------------------------------------------------------------------- */

export interface SafeDataFactoryOptions<T> extends DataFactoryOptions<T> {
  /**
   * Called when attach() fails safeParse on the new value.
   *
   * Return:
   * - T: replacement value which will then be attached (and validated again).
   * - null | undefined: do nothing (value is not stored).
   */
  onAttachSafeParseError?: (ctx: {
    node: Node;
    attemptedValue: unknown;
    error: z.ZodError<T>;
  }) => T | null | undefined;

  /**
   * Called when attach() with merge=true fails safeParse on an existing value.
   *
   * Return:
   * - T: replacement value which is used as the "existing" side for merge.
   * - null | undefined: treat as if there was no existing value.
   */
  onExistingSafeParseError?: (ctx: {
    node: Node;
    existingValue: unknown;
    error: z.ZodError<T>;
  }) => T | null | undefined;

  /**
   * Called when safeGet() fails safeParse on the stored value.
   *
   * Return:
   * - T: replacement value which safeGet() will return.
   * - null | undefined: safeGet() returns undefined.
   */
  onSafeGetSafeParseError?: (ctx: {
    node: Node;
    storedValue: unknown;
    error: z.ZodError<T>;
  }) => T | null | undefined;
}

export interface SafeArrayDataFactoryOptions<T>
  extends ArrayDataFactoryOptions {
  /**
   * Called when add() fails safeParse on the incoming items.
   *
   * Return:
   * - T[]: replacement array of items to use instead.
   * - null | undefined: do nothing (no items stored).
   */
  onAddSafeParseError?: (ctx: {
    node: Node;
    attemptedItems: readonly unknown[];
    error: z.ZodError<T[]>;
  }) => T[] | null | undefined;

  /**
   * Called when add() with merge=true fails safeParse on an existing array.
   *
   * Return:
   * - T[]: replacement array used as the "existing" side for merge.
   * - null | undefined: treat as if there was no existing array.
   */
  onExistingSafeParseError?: (ctx: {
    node: Node;
    existingValue: unknown;
    error: z.ZodError<T[]>;
  }) => T[] | null | undefined;

  /**
   * Called when safeGet() fails safeParse on the stored array.
   *
   * Return:
   * - T[]: replacement array which safeGet() will return.
   * - null | undefined: safeGet() returns [].
   */
  onSafeGetSafeParseError?: (ctx: {
    node: Node;
    storedValue: unknown;
    error: z.ZodError<T[]>;
  }) => T[] | null | undefined;
}

/**
 * Helper to safeParse a value and, on error, delegate to a callback
 * which can provide a replacement or decline to handle.
 */
function safeParseWithHandler<T>(
  node: Node,
  value: unknown,
  schema: z.ZodType<T>,
  handler:
    | ((ctx: {
      node: Node;
      storedValue?: unknown;
      attemptedValue?: unknown;
      existingValue?: unknown;
      error: z.ZodError<T>;
    }) => T | null | undefined)
    | undefined,
  kind:
    | "attach"
    | "existing"
    | "safeGet",
): T | undefined {
  const res = schema.safeParse(value);
  if (res.success) return res.data as T;

  if (!handler) return undefined;

  const ctxBase = {
    node,
    error: res.error,
  };

  let replacement: T | null | undefined;

  switch (kind) {
    case "attach":
      replacement = handler({
        ...ctxBase,
        attemptedValue: value,
      });
      break;
    case "existing":
      replacement = handler({
        ...ctxBase,
        existingValue: value,
      });
      break;
    case "safeGet":
      replacement = handler({
        ...ctxBase,
        storedValue: value,
      });
      break;
  }

  if (replacement === null || replacement === undefined) return undefined;

  const again = schema.safeParse(replacement);
  return again.success ? (again.data as T) : undefined;
}

/**
 * Create a Zod-backed data factory that never throws.
 *
 * - On attach(): safeParse the incoming value; on error, call
 *   options.onAttachSafeParseError. Depending on its return value, may attach
 *   a replacement or skip attaching.
 * - On merge attach(): also safeParse the existing value; on error, call
 *   options.onExistingSafeParseError.
 * - On safeGet(): safeParse existing stored value; on error, call
 *   options.onSafeGetSafeParseError.
 *
 * - get(): returns raw stored value (no validation, no logging).
 * - Both get/safeGet accept an optional `ifNotExists` callback:
 *   - If no stored value and callback is provided, it is called to create
 *     a value, which is attached and returned (no extra Zod or callbacks).
 */
export function safeNodeDataFactory<
  Key extends string,
  T,
>(
  key: Key,
  schema: z.ZodType<T>,
  options?: SafeDataFactoryOptions<T>,
): DataFactory<Key, T> {
  const mergeEnabled = options?.merge === true;

  return {
    key,

    attach<N extends Node>(node: N, value: T) {
      const parsed = safeParseWithHandler<T>(
        node,
        value,
        schema,
        options?.onAttachSafeParseError
          ? (ctx) =>
            options.onAttachSafeParseError?.({
              node: ctx.node,
              attemptedValue: ctx.attemptedValue,
              error: ctx.error,
            })
          : undefined,
        "attach",
      );

      if (parsed === undefined) {
        // Validation failed and handler declined to fix it.
        return node as DataSupplierNode<N, Key, T>;
      }

      if (!mergeEnabled) {
        return attachData<N, Key, T>(node, key, parsed);
      }

      const existingRaw = getData<unknown, N, Key>(node, key);
      let existingParsed: T | undefined;

      if (existingRaw !== undefined) {
        existingParsed = safeParseWithHandler<T>(
          node,
          existingRaw,
          schema,
          options?.onExistingSafeParseError
            ? (ctx) =>
              options.onExistingSafeParseError?.({
                node: ctx.node,
                existingValue: ctx.existingValue,
                error: ctx.error,
              })
            : undefined,
          "existing",
        );
      }

      let next: T;
      if (
        existingParsed !== undefined &&
        isPlainObject(existingParsed) &&
        isPlainObject(parsed)
      ) {
        next = deepMerge(existingParsed, parsed as Partial<T>);
      } else {
        next = parsed;
      }

      return attachData<N, Key, T>(node, key, next);
    },

    get<N extends Node>(
      node: N,
      ifNotExists?: (node: N) => T,
    ): T | undefined {
      // Raw, unvalidated access: no Zod, no callbacks.
      const raw = getData<unknown, N, Key>(node, key);
      if (raw !== undefined) return raw as T;

      if (!ifNotExists) return undefined;
      const created = ifNotExists(node);
      if (created === undefined) return undefined;
      attachData<N, Key, T>(node, key, created);
      return created;
    },

    safeGet<N extends Node>(
      node: N,
      ifNotExists?: (node: N) => T,
    ): T | undefined {
      const raw = getData<unknown, N, Key>(node, key);

      if (raw !== undefined) {
        const parsed = safeParseWithHandler<T>(
          node,
          raw,
          schema,
          options?.onSafeGetSafeParseError
            ? (ctx) =>
              options.onSafeGetSafeParseError?.({
                node: ctx.node,
                storedValue: ctx.storedValue,
                error: ctx.error,
              })
            : undefined,
          "safeGet",
        );
        return parsed;
      }

      if (!ifNotExists) return undefined;
      const created = ifNotExists(node);
      if (created === undefined) return undefined;

      // We trust the provided default and attach it directly.
      attachData<N, Key, T>(node, key, created);
      return created;
    },

    is<N extends Node>(node: N): node is DataSupplierNode<N, Key, T> {
      return isDataSupplier<T, N, Key>(node, key);
    },

    collect(root: Root): readonly T[] {
      return collectData<T, Key>(root, key);
    },

    collectNodes<N extends Node>(
      root: Root,
    ): readonly DataSupplierNode<N, Key, T>[] {
      const out: DataSupplierNode<Node, Key, T>[] = [];
      forEachData<T, Key>(root, key, (_value, owner) => {
        out.push(owner as DataSupplierNode<Node, Key, T>);
      });
      return out as DataSupplierNode<N, Key, T>[];
    },

    forEach(
      root: Root,
      fn: (value: T, owner: DataSupplierNode<Node, Key, T>) => void,
    ): void {
      forEachData<T, Key>(root, key, fn);
    },

    hasAny(root: Root): boolean {
      return hasAnyData(root, key);
    },
  };
}

/**
 * Create a Zod-backed array-valued data factory that never throws.
 *
 * - Stores `T[]` at `node.data[key]`.
 * - add(): validates incoming items (and existing array if present when
 *   merge=true), delegating errors to callbacks in options.
 * - safeGet(): validates stored array, delegating errors to callbacks.
 * - get(): returns raw stored array or [] if missing (no validation).
 * - Both get/safeGet accept `ifNotExists`, which creates & attaches a default
 *   array when missing (no extra validation).
 */
export function safeNodeArrayDataFactory<
  Key extends string,
  T,
>(
  key: Key,
  itemSchema: z.ZodType<T>,
  options?: SafeArrayDataFactoryOptions<T>,
): ArrayDataFactory<Key, T> {
  const merge = options?.merge !== false; // default: true
  const arraySchema = z.array(itemSchema);

  return {
    key,

    add<N extends Node>(node: N, ...items: readonly T[]) {
      // Validate the incoming items as an array
      const parsedItems = ((): T[] | undefined => {
        const res = arraySchema.safeParse(items);
        if (res.success) return res.data;

        if (!options?.onAddSafeParseError) return undefined;
        const replacement = options.onAddSafeParseError({
          node,
          attemptedItems: items,
          error: res.error,
        });

        if (!replacement) return undefined;
        const again = arraySchema.safeParse(replacement);
        return again.success ? again.data : undefined;
      })();

      if (!parsedItems) {
        return node as DataSupplierNode<N, Key, T[]>;
      }

      const existingRaw = merge
        ? getData<unknown, N, Key>(node, key)
        : undefined;

      const existingParsed = ((): T[] | undefined => {
        if (existingRaw === undefined) return undefined;

        const res = arraySchema.safeParse(existingRaw);
        if (res.success) return res.data;

        if (!options?.onExistingSafeParseError) return undefined;
        const replacement = options.onExistingSafeParseError({
          node,
          existingValue: existingRaw,
          error: res.error,
        });

        if (!replacement) return undefined;
        const again = arraySchema.safeParse(replacement);
        return again.success ? again.data : undefined;
      })();

      const base: T[] = existingParsed ?? [];
      const next = base.concat(parsedItems);
      return attachData<N, Key, T[]>(node, key, next);
    },

    get<N extends Node>(
      node: N,
      ifNotExists?: (node: N) => T[],
    ): T[] {
      const raw = getData<unknown, N, Key>(node, key);
      if (raw !== undefined) return raw as T[];

      if (!ifNotExists) return [];
      const created = ifNotExists(node);
      if (!created) return [];
      attachData<N, Key, T[]>(node, key, created);
      return created;
    },

    safeGet<N extends Node>(
      node: N,
      ifNotExists?: (node: N) => T[],
    ): T[] {
      const raw = getData<unknown, N, Key>(node, key);
      if (raw !== undefined) {
        const res = arraySchema.safeParse(raw);
        if (res.success) return res.data;

        if (!options?.onSafeGetSafeParseError) return [];
        const replacement = options.onSafeGetSafeParseError({
          node,
          storedValue: raw,
          error: res.error,
        });

        if (!replacement) return [];
        const again = arraySchema.safeParse(replacement);
        return again.success ? again.data : [];
      }

      if (!ifNotExists) return [];
      const created = ifNotExists(node);
      if (!created) return [];
      attachData<N, Key, T[]>(node, key, created);
      return created;
    },

    is<N extends Node>(node: N): node is DataSupplierNode<N, Key, T[]> {
      return isDataSupplier<T[], N, Key>(node, key);
    },

    collect(root: Root): readonly T[] {
      const buckets = collectData<T[], Key>(root, key);
      const out: T[] = [];
      for (const bucket of buckets) {
        if (Array.isArray(bucket)) out.push(...bucket);
      }
      return out;
    },

    collectNodes<N extends Node>(
      root: Root,
    ): readonly DataSupplierNode<N, Key, T[]>[] {
      const out: DataSupplierNode<Node, Key, T[]>[] = [];
      const seen = new Set<DataSupplierNode<Node, Key, T[]>>();

      forEachData<T[], Key>(root, key, (bucket, owner) => {
        if (!Array.isArray(bucket) || bucket.length === 0) return;

        const typedOwner = owner as DataSupplierNode<Node, Key, T[]>;
        if (seen.has(typedOwner)) return;

        seen.add(typedOwner);
        out.push(typedOwner);
      });

      return out as DataSupplierNode<N, Key, T[]>[];
    },

    forEach(
      root: Root,
      fn: (item: T, owner: DataSupplierNode<Node, Key, T[]>) => void,
    ): void {
      forEachData<T[], Key>(root, key, (bucket, owner) => {
        if (!Array.isArray(bucket)) return;
        for (const item of bucket) {
          fn(item, owner as DataSupplierNode<Node, Key, T[]>);
        }
      });
    },

    hasAny(root: Root): boolean {
      let found = false;
      forEachData<T[], Key>(root, key, (bucket) => {
        if (!found && Array.isArray(bucket) && bucket.length > 0) {
          found = true;
        }
      });
      return found;
    },
  };
}

export const flexibleTextSchema = z.union([z.string(), z.array(z.string())]);
export type FlexibleText = z.infer<typeof flexibleTextSchema>;

export const mergeFlexibleText = (
  shortcut?: FlexibleText,
  long?: FlexibleText,
): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];

  if (shortcut !== undefined) {
    if (Array.isArray(shortcut)) {
      for (const s of shortcut) {
        if (!seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
    } else if (!seen.has(shortcut)) {
      seen.add(shortcut);
      out.push(shortcut);
    }
  }

  if (long !== undefined) {
    if (Array.isArray(long)) {
      for (const s of long) {
        if (!seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
    } else if (!seen.has(long)) {
      seen.add(long);
      out.push(long);
    }
  }

  return out;
};
