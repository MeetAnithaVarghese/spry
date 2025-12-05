// vfile-resource.ts
//
// Tiny bridge between Resource (resource.ts) and the unified ecosystem's VFile.
//
// Responsibilities:
// - For utf8-text resources, call safeText()
// - Wrap the text in a VFile
// - Attach provenance to vfile.data
// - Attach a `file` property on the Resource
//
// No AST, no mdText, no remark pipeline logic here.

import { VFile } from "vfile";
import {
  type Resource,
  type ResourcePlugin,
  type ResourceProvenance,
  type ResourcesFactory,
  resourcesFactory,
  type ResourcesFactoryInit,
  type ResourceStrategy,
} from "../../universal/resource.ts";

/* -------------------------------------------------------------------------- */
/*                       Markdown-flavored provenance                         */
/* -------------------------------------------------------------------------- */

/**
 * Canonical markdown MIME types.
 */
export type MarkdownMimeTypeBase =
  | "text/markdown"
  | "text/x-markdown"
  | "text/md";

/**
 * Markdown MIME types including parameterized variants like
 * "text/markdown; charset=utf-8".
 */
export type MarkdownMimeType =
  | MarkdownMimeTypeBase
  | `${MarkdownMimeTypeBase};${string}`;

/**
 * A ResourceProvenance specialized for markdown/text sources.
 *
 * Use this as the P generic when your pipeline is only dealing
 * with markdown, for stronger type-safety around mimeType.
 */
export type MarkdownProvenance =
  & Omit<ResourceProvenance, "mimeType">
  & { readonly mimeType: MarkdownMimeType };

/**
 * Runtime helper for narrowing arbitrary mimeTypes to MarkdownMimeType.
 */
export function isMarkdownMime(
  mimeType?: string,
): mimeType is MarkdownMimeType {
  if (!mimeType) return false;
  const lower = mimeType.toLowerCase();
  return lower.startsWith("text/markdown") ||
    lower === "text/md" ||
    lower.startsWith("text/x-markdown");
}

/**
 * Narrow a Resource to one whose provenance is MarkdownProvenance.
 */
export function isMarkdownResource<S extends ResourceStrategy>(
  r: Resource<ResourceProvenance, S>,
): r is Resource<MarkdownProvenance, S> {
  return isMarkdownMime(r.provenance.mimeType);
}

/* -------------------------------------------------------------------------- */
/*                          VFile resource wiring                             */
/* -------------------------------------------------------------------------- */

/**
 * A Resource enriched with a VFile.
 *
 * The `file` is a standard unified VFile with its `data.provenance`
 * field set to the resource's provenance.
 */
export type VFileCapableResource<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = Resource<P, S> & {
  readonly file: VFile & {
    data: VFile["data"] & { provenance: P };
  };
};

/**
 * Type guard: does this resource carry a VFile?
 */
export const isVFileResource = <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  r: Resource<P, S>,
): r is VFileCapableResource<P, S> =>
  // deno-lint-ignore no-explicit-any
  (r as any).file instanceof VFile;

/* -------------------------------------------------------------------------- */
/*                           Plugin + factory init                            */
/* -------------------------------------------------------------------------- */

export interface VFilePluginInit<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> {
  /**
   * Optional working directory for created VFiles.
   */
  readonly cwd?: string | URL;

  /**
   * Optional override for the VFile path derived from a Resource's provenance.
   * Defaults to `provenance.label ?? provenance.path`.
   */
  readonly pathFromProvenance?: (prov: P) => string | undefined;

  /**
   * Optional text-load error hook.
   *
   * If provided, this is invoked when `safeText()` fails.
   * You can return:
   *   - a replacement VFileCapableResource, or
   *   - `false` to skip this resource.
   *
   * If not provided (or returns `false`), the failing resource is skipped.
   */
  readonly onTextError?: (
    origin: Resource<P, S>,
    error: Error,
  ) =>
    | VFileCapableResource<P, S>
    | false
    | Promise<VFileCapableResource<P, S> | false>;
}

/**
 * Generic VFile plugin.
 *
 * - Only applies to resources with `strategy.encoding === "utf8-text"`.
 * - Loads text via `safeText()`.
 * - Creates a VFile.
 * - Attaches provenance to `file.data.provenance`.
 * - Returns an enriched Resource with a `file` property.
 */
export function vfilePlugin<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  init: VFilePluginInit<P, S> = {},
): ResourcePlugin<P, S> {
  const { cwd, pathFromProvenance, onTextError } = init;

  return async (
    resource: Resource<P, S>,
  ): Promise<VFileCapableResource<P, S> | void> => {
    // Only text-encoded resources are eligible.
    if (resource.strategy.encoding !== "utf8-text") return;

    const prov = resource.provenance;
    const loaded = await resource.safeText();

    if (typeof loaded !== "string") {
      const err = loaded instanceof Error ? loaded : new Error(String(loaded));
      if (onTextError) {
        const replacement = await onTextError(resource, err);
        if (replacement) return replacement;
      }
      return;
    }

    const path = pathFromProvenance?.(prov) ?? prov.label ?? prov.path;

    const file = new VFile({
      value: loaded,
      path,
      cwd: cwd ? String(cwd) : undefined,
    }) as VFile & { data: VFile["data"] & { provenance: P } };

    file.data = {
      ...(file.data ?? {}),
      provenance: prov,
    };

    const enriched = {
      ...resource,
      file,
    } as VFileCapableResource<P, S>;

    return enriched;
  };
}

/* -------------------------------------------------------------------------- */
/*                     Convenience: factory with plugin                       */
/* -------------------------------------------------------------------------- */

export type VFileResourcesFactoryInit<
  P extends ResourceProvenance = MarkdownProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> =
  & ResourcesFactoryInit<P, S>
  & VFilePluginInit<P, S>
  & {
    /**
     * Optional custom factory creator.
     *
     * If not provided, the default `resourcesFactory` is used.
     */
    readonly makeFactory?: (
      init?: ResourcesFactoryInit<P, S>,
    ) => ResourcesFactory<P, S>;
  };

/**
 * Create a ResourcesFactory pre-wired with the VFile plugin.
 *
 * By default, it:
 *   - uses `resourcesFactory` from resource.ts
 *   - assumes markdown-flavored provenance as the default generic
 *
 * You can override `makeFactory` to plug in a custom core factory.
 */
export function vfileResourcesFactory<
  P extends ResourceProvenance = MarkdownProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  init: VFileResourcesFactoryInit<P, S> = {},
): ResourcesFactory<P, S> {
  const { makeFactory, cwd, pathFromProvenance, onTextError, ...rfInit } = init;

  const coreFactory = makeFactory ?? resourcesFactory<P, S>;
  const rf = coreFactory(rfInit);

  rf.use(
    vfilePlugin<P, S>({
      cwd,
      pathFromProvenance,
      onTextError,
    }),
  );

  return rf;
}
