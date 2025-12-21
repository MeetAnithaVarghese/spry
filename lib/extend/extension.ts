/**
 * @module extension
 *
 * Hook-focused, library-agnostic extension loader and scanner.
 *
 * This module is responsible for **importing extension modules**, discovering
 * hook implementations created by `hook()` / `hook.async()`, and exposing them
 * in a structured, host-friendly form.
 *
 * Design goals:
 *
 * - No dependency on hook definitions themselves
 * - No framework assumptions (no ASTs, no decorators, no metadata emit)
 * - Safe scanning of arbitrary modules
 * - Clear separation between discovery, execution, and registration
 *
 * Core responsibilities:
 *
 * - Dynamic module import via specifier (path / URL)
 * - Optional support for a default entrypoint function
 * - Reflective scanning of module exports for HookImpl functions
 * - Defensive handling of malformed exports or metadata
 * - Structured issue reporting via `IssueSink`
 *
 * Key abstractions:
 *
 * - `ExtensionHandle`
 *     Represents a single extension module and manages:
 *       - Import lifecycle
 *       - Hook scanning
 *       - Caching of import results
 *       - Issue aggregation
 *
 * - `ExtensionImportResult`
 *     Immutable snapshot of:
 *       - Imported module
 *       - Default entrypoint (if present)
 *       - Discovered hook implementations
 *
 * - `registerExtensionHooks(...)`
 *     Optional integration point for registering discovered hooks into
 *     a host-provided registry (router, dispatcher, executor, etc.).
 *
 * Error and warning philosophy:
 *
 * - Import failures are captured as issues and return `undefined`
 * - Malformed hook exports are skipped with warnings
 * - Registry failures are isolated per hook
 * - Extension scanning never throws unless explicitly requested
 *
 * This module does **not**:
 * - Execute hooks
 * - Know about hook schemas
 * - Enforce any runtime policies beyond discovery
 *
 * It is intended to be composed with higher-level orchestration layers,
 * not to act as a framework itself.
 */
import {
  type AnyHookImpl,
  getHookImplMeta,
  type HookImplMeta,
  isHookImpl,
} from "./hook.ts";

/* -------------------------------------------------------------------------- */
/* Issues                                                                      */
/* -------------------------------------------------------------------------- */

export type IssueSeverity = "info" | "warn" | "error";

export type Issue = Readonly<{
  severity: IssueSeverity;
  code: string;
  message: string;
  error?: unknown;
  detail?: unknown;
}>;

export class IssueSink {
  #issues: Issue[] = [];

  list(): readonly Issue[] {
    return this.#issues;
  }

  clear(): void {
    this.#issues.length = 0;
  }

  add(issue: Issue): void {
    this.#issues.push(issue);
  }

  info(code: string, message: string, detail?: unknown): void {
    this.add({ severity: "info", code, message, detail });
  }

  warn(code: string, message: string, detail?: unknown): void {
    this.add({ severity: "warn", code, message, detail });
  }

  error(
    code: string,
    message: string,
    error?: unknown,
    detail?: unknown,
  ): void {
    this.add({ severity: "error", code, message, error, detail });
  }
}

/* -------------------------------------------------------------------------- */
/* Core types                                                                  */
/* -------------------------------------------------------------------------- */

export type ExtensionEntrypoint<Ctx = unknown, Api = unknown> =
  | ((ctx?: Ctx) => Api | Promise<Api>)
  | undefined;

export type HookImplRecord = Readonly<{
  exportName: string;
  impl: AnyHookImpl;
  hookId: string;
  hookName?: string;
  meta: HookImplMeta;
}>;

export type ExtensionImportResult<Ctx = unknown, Api = unknown> = Readonly<{
  specifier: string;
  module: unknown;
  entrypoint?: ExtensionEntrypoint<Ctx, Api>;
  hooks: readonly HookImplRecord[];
}>;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

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

function getDefaultEntrypoint<Ctx, Api>(
  module: unknown,
): ExtensionEntrypoint<Ctx, Api> {
  if (!module || (typeof module !== "object" && typeof module !== "function")) {
    return undefined;
  }
  const d = (module as Record<string, unknown>).default;
  return typeof d === "function"
    ? (d as ExtensionEntrypoint<Ctx, Api>)
    : undefined;
}

function scanHooks(
  module: unknown,
  issues: IssueSink,
): readonly HookImplRecord[] {
  const out: HookImplRecord[] = [];

  for (const [exportName, value] of entriesOf(module)) {
    if (exportName === "default") continue;
    if (typeof value !== "function") continue;

    // First prove it's a HookImpl.
    let ok = false;
    try {
      ok = isHookImpl(value);
    } catch (err) {
      issues.warn(
        "EXT_HOOK_PREDICATE_THROW",
        "isHookImpl threw while scanning module exports",
        { exportName, err },
      );
      continue;
    }
    if (!ok) continue;

    // Now it's safe to narrow.
    const impl = value as AnyHookImpl;

    // meta can be undefined by signature; treat missing meta as a scan failure.
    let meta: HookImplMeta | undefined;
    try {
      meta = getHookImplMeta(impl);
    } catch (err) {
      issues.warn(
        "EXT_HOOK_META_THROW",
        "getHookImplMeta threw while scanning module exports",
        { exportName, err },
      );
      continue;
    }
    if (!meta) {
      issues.warn(
        "EXT_HOOK_META_MISSING",
        "hook impl matched isHookImpl but had no readable HookImplMeta",
        { exportName },
      );
      continue;
    }

    out.push({
      exportName,
      impl,
      hookId: meta.id,
      hookName: meta.name,
      meta,
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* ExtensionHandle                                                             */
/* -------------------------------------------------------------------------- */

export type ExtensionHandleOptions = Readonly<{
  issues?: IssueSink;

  /**
   * Optional importer for tests or alternate runtimes.
   * Defaults to native dynamic import (via Function indirection).
   */
  importer?: (specifier: string) => Promise<unknown>;

  /**
   * If true (default), warn when module has no hooks and no default entrypoint.
   */
  warnIfEmpty?: boolean;
}>;

export class ExtensionHandle<Ctx = unknown, Api = unknown> {
  readonly specifier: string;
  readonly issues: IssueSink;

  #opts: ExtensionHandleOptions;
  #imported?: ExtensionImportResult<Ctx, Api>;

  constructor(specifier: string, opts: ExtensionHandleOptions = {}) {
    this.specifier = specifier;
    this.#opts = opts;
    this.issues = opts.issues ?? new IssueSink();
  }

  get imported(): ExtensionImportResult<Ctx, Api> | undefined {
    return this.#imported;
  }

  import = (): Promise<ExtensionImportResult<Ctx, Api> | undefined> => {
    return this.#importInternal();
  };

  async #importInternal(): Promise<
    ExtensionImportResult<Ctx, Api> | undefined
  > {
    if (this.#imported) return this.#imported;

    const importer = this.#opts.importer ??
      ((s: string) => {
        // indirection avoids TS rewriting import()
        const dyn = new Function("s", "return import(s);") as (
          s: string,
        ) => Promise<unknown>;
        return dyn(s);
      });

    try {
      const module = await importer(this.specifier);
      const entrypoint = getDefaultEntrypoint<Ctx, Api>(module);
      const hooks = scanHooks(module, this.issues);

      if (
        this.#opts.warnIfEmpty !== false && !entrypoint && hooks.length === 0
      ) {
        this.issues.warn(
          "EXT_EMPTY",
          `Extension '${this.specifier}' exported no hooks and no default entrypoint`,
          { specifier: this.specifier },
        );
      }

      this.#imported = {
        specifier: this.specifier,
        module,
        entrypoint,
        hooks,
      };

      return this.#imported;
    } catch (err) {
      this.issues.error(
        "EXT_IMPORT_FAILED",
        `Failed to import extension '${this.specifier}'`,
        err,
        { specifier: this.specifier },
      );
      return undefined;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Registry integration (optional)                                             */
/* -------------------------------------------------------------------------- */

export type HookRegistry = Readonly<{
  register(
    hookId: string,
    impl: AnyHookImpl,
    info?: Readonly<{
      exportName: string;
      specifier: string;
      hookName?: string;
    }>,
  ): void;
}>;

export function registerExtensionHooks(
  imported: ExtensionImportResult,
  registry: HookRegistry,
  issues?: IssueSink,
): void {
  for (const h of imported.hooks) {
    try {
      registry.register(h.hookId, h.impl, {
        exportName: h.exportName,
        specifier: imported.specifier,
        hookName: h.hookName,
      });
    } catch (err) {
      issues?.warn(
        "EXT_REGISTER_FAILED",
        "Hook registry threw while registering hook",
        { hookId: h.hookId, err },
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience                                                                 */
/* -------------------------------------------------------------------------- */

export function extensionHandle<Ctx = unknown, Api = unknown>(
  specifier: string,
  opts: ExtensionHandleOptions = {},
): ExtensionHandle<Ctx, Api> {
  return new ExtensionHandle<Ctx, Api>(specifier, opts);
}
