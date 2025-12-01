import z, { ZodType } from "@zod/zod";
import { jsonToZod } from "./zod-aide.ts";
import { globToRegExp, isGlob, normalize } from "@std/path";

/** Render function for partials */
export type InjectContentFn = (
  locals: Record<string, unknown>,
  onError?: (message: string, content: string, error?: unknown) => string,
) =>
  | { content: string; interpolate: boolean; locals: Record<string, unknown> }
  | Promise<
    { content: string; interpolate: boolean; locals: Record<string, unknown> }
  >;

export const partialContentSchema = z.object({
  identity: z.string().min(1),
  source: z.string().min(1),

  // Optional argument validation for locals passed to .content()
  argsZodSchema: z.instanceof(ZodType).optional(),
  argsZodSchemaSpec: z.string().optional(),

  // The renderer (typed & guarded)
  content: z.custom<InjectContentFn>(
    (v): v is InjectContentFn =>
      typeof v === "function" &&
      // deno-lint-ignore ban-types
      (v as Function).length >= 1 &&
      // deno-lint-ignore ban-types
      (v as Function).length <= 2,
    {
      message:
        "content must be a function (locals, onError?) => { content, interpolate, locals } | Promise<...>",
    },
  ),

  // optional injection metadata
  injection: z.object({
    globs: z.array(z.string()).min(1),
    mode: z.enum(["prepend", "append", "both"]),
    wrap: z.custom<(content: string) => string>(),
  }).optional(),
}).strict();

export type PartialContent = z.infer<typeof partialContentSchema>;

/**
 * Build a (possibly injectable) Partial from the fenced block’s `PI` and `content`.
 *
 * Flags parsed from `PI` (via parsedTextComponents):
 *   --inject <glob>   (repeatable; optional – if absent, the partial is "plain")
 *   --prepend         (optional; if neither --prepend/--append given, default "prepend")
 *   --append          (optional; --prepend + --append => "both")
 *
 * Examples:
 *   fbPartial("report_wrapper --inject reports/**\/*.sql --prepend", "...text...");
 *   fbPartial("footer --inject **\/*.sql --append", "-- footer");
 *   fbPartial("enclose --inject **\/*.sql --prepend --append", "-- begin\n...\n-- end");
 *   fbPartial("plain_partial", "no injection flags => plain partial");
 */
export function partialContent(
  identity: string,
  source: string,
  zodSchemaSpec?: Record<string, unknown>,
  init?: {
    injectGlobs?: string[];
    registerIssue?: (message: string, content: string, error?: unknown) => void;
    append?: boolean;
    prepend?: boolean;
  },
): PartialContent {
  const { injectGlobs = [], prepend = false, append = false } = init ?? {};
  let hasPrepend = prepend;
  const hasAppend = append;
  if (!hasPrepend && !hasAppend) hasPrepend = true;

  const injection: PartialContent["injection"] = injectGlobs.length
    ? {
      globs: injectGlobs,
      mode: hasPrepend && hasAppend ? "both" : hasAppend ? "append" : "prepend", // default if neither specified
      wrap: (text: string) => {
        let result = text;
        if (hasPrepend) {
          result = `${source}\n${result}`;
        }
        if (hasAppend) {
          result = `${result}\n${source}`;
        }
        return result;
      },
    }
    : undefined;

  // Optional Zod schema for locals
  const argsZodSchemaSpec = JSON.stringify(
    zodSchemaSpec && Object.keys(zodSchemaSpec).length > 0
      ? zodSchemaSpec
      : undefined,
  );

  let argsZodSchema: ZodType | undefined;
  if (argsZodSchemaSpec) {
    try {
      argsZodSchema = jsonToZod(JSON.stringify({
        type: "object",
        properties: JSON.parse(argsZodSchemaSpec),
        additionalProperties: true,
      }));
    } catch (error) {
      argsZodSchema = undefined;
      init?.registerIssue?.(
        `Invalid Zod schema spec: ${argsZodSchemaSpec}`,
        source,
        error,
      );
    }
  }

  // The content renderer with runtime locals validation (if provided)
  const content: InjectContentFn = (locals, onError) => {
    if (argsZodSchema) {
      const parsed = z.safeParse(argsZodSchema, locals);
      if (!parsed.success) {
        const message =
          `Invalid arguments passed to partial '${identity}': ${
            z.prettifyError(parsed.error)
          }\n` +
          `Partial '${identity}' expected arguments ${argsZodSchemaSpec}`;
        return {
          content: onError ? onError(message, source, parsed.error) : message,
          interpolate: false,
          locals,
        };
      }
    }
    return { content: source, interpolate: true, locals };
  };

  return partialContentSchema.parse({
    identity,
    argsZodSchema,
    argsZodSchemaSpec,
    source,
    content,
    injection,
  });
}

type PartialRender = Awaited<ReturnType<InjectContentFn>>;

/**
 * Unified collection of Partials. It also maintains an index for injectable
 * matching (by glob) and exposes a `compose` helper to apply the best-match
 * wrapper around a rendered content partial’s result.
 */
export function partialContentCollection() {
  const catalog = new Map<string, PartialContent>();

  // ---------- Injectable indexing ----------
  type IndexEntry = {
    identity: string;
    re: RegExp;
    wc: number;
    len: number;
  };
  let index: IndexEntry[] = [];

  const wildcardCount = (g: string): number => {
    const starStar = (g.match(/\*\*/g) ?? []).length * 2;
    const singles = (g.replace(/\*\*/g, "").match(/[*?]/g) ?? []).length;
    return starStar + singles;
  };

  const toRegex = (glob: string): RegExp => {
    if (!isGlob(glob)) {
      const exact = normalize(glob).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${exact}$`);
    }
    return globToRegExp(glob, {
      extended: true,
      globstar: true,
      caseInsensitive: false,
    });
    // If you prefer case-insensitive, flip the flag above.
  };

  const rebuildIndex = () => {
    const entries: IndexEntry[] = [];
    for (const codePartial of catalog.values()) {
      const inj = codePartial.injection;
      if (!inj) continue;
      for (const g of inj.globs) {
        const gg = normalize(g);
        entries.push({
          identity: codePartial.identity,
          re: toRegex(gg),
          wc: wildcardCount(gg),
          len: gg.length,
        });
      }
    }
    index = entries;
  };

  const findInjectableForPath = (
    path?: string,
  ): PartialContent | undefined => {
    if (!path) return;
    const p = normalize(path);
    const hits = index
      .filter((c) => c.re.test(p))
      .sort((a, b) => (a.wc - b.wc) || (b.len - a.len));
    if (!hits.length) return;
    const chosenId = hits[0].identity;
    return catalog.get(chosenId);
  };
  // ----------------------------------------

  return {
    catalog,

    register: (
      codePartial: PartialContent,
      onDuplicate?: (cp: PartialContent) => "overwrite" | "throw" | "ignore",
    ) => {
      const found = catalog.get(codePartial.identity);
      if (found && onDuplicate) {
        const action = onDuplicate(codePartial);
        if (action === "throw") {
          throw new Deno.errors.AlreadyExists(
            `Partial '${codePartial.identity}' already exists in fbPartialsCollection`,
          );
        }
        if (action === "ignore") return;
        // default is overwrite
      }
      catalog.set(codePartial.identity, codePartial);
      rebuildIndex();
    },

    get: (identity: string) => catalog.get(identity),

    /**
     * Compose the best matching injectable (if any) around a prior render result.
     * - Looks up the most specific injection by path (glob, fewer wildcards, longer literal).
     * - Renders the wrapper with the same locals.
     * - Prepends/appends/both according to the injection mode.
     */
    async compose(
      result: PartialRender,
      ctx?: {
        path?: string;
        onError?: (msg: string, content: string, err?: unknown) => string;
      },
    ): Promise<PartialRender> {
      const wrapper = findInjectableForPath(ctx?.path);
      if (!wrapper?.injection) return result;

      // Render wrapper using same locals; fail closed if wrapper indicates invalid args.
      let wrapperText: string;
      try {
        const wr = await wrapper.content(result.locals);
        if (!wr.interpolate) {
          const msg = `Injectable '${wrapper.identity}' failed to render`;
          const text = ctx?.onError
            ? ctx.onError(msg, result.content)
            : `${msg}: wrapper reported invalid arguments`;
          return { content: text, interpolate: false, locals: result.locals };
        }
        wrapperText = wr.content;
      } catch (err) {
        const msg = `Injectable '${wrapper.identity}' failed to render`;
        const text = ctx?.onError
          ? ctx.onError(msg, result.content, err)
          : `${msg}: ${String(err)}`;
        return { content: text, interpolate: false, locals: result.locals };
      }

      // Merge according to mode
      const { mode } = wrapper.injection;
      let merged = result.content;
      if (mode === "prepend" || mode === "both") {
        merged = `${wrapperText}\n${merged}`;
      }
      if (mode === "append" || mode === "both") {
        merged = `${merged}\n${wrapperText}`;
      }

      return {
        content: merged,
        interpolate: result.interpolate,
        locals: result.locals,
      };
    },

    /** Utility: find the (injectable) partial chosen for a path */
    findInjectableForPath,
  };
}
