import z, { ZodType } from "@zod/zod";
import { Code } from "types/mdast";
import { defineSafeNodeData, NodeWithData } from "../../universal/data-bag.ts";
import { jsonToZod } from "../../universal/zod-aide.ts";
import { codeFrontmatterNDF } from "./code-frontmatter.ts";
import { addIssue } from "./node-issues.ts";

/** Render function for partials */
type InjectContentFn = (
  locals: Record<string, unknown>,
  onError?: (message: string, content: string, error?: unknown) => string,
) =>
  | { content: string; interpolate: boolean; locals: Record<string, unknown> }
  | Promise<
    { content: string; interpolate: boolean; locals: Record<string, unknown> }
  >;

export const codePartialSchema = z.object({
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

export type CodePartial = z.infer<typeof codePartialSchema>;

/**
 * Data-bag definition for `code` frontmatter:
 *
 *   node.data.codeFM: CodeFrontmatter
 */
export const codePartialDefn = defineSafeNodeData("codePartial" as const)<
  CodePartial,
  Code
>(codePartialSchema, {
  initOnFirstAccess: true,
  init: (node, ctx) => {
    if (codeFrontmatterNDF.is(node)) {
      const { pi, attrs } = node.data.codeFM;
      if (pi.posCount > 1 && pi.pos[0] == "PARTIAL") {
        ctx.factory.attach(
          node,
          codePartial(
            pi.pos[1],
            pi.flags,
            node.value,
            attrs,
            {
              registerIssue: (message, content, error) =>
                addIssue(node, {
                  message,
                  severity: "error",
                  error,
                  data: { content },
                }),
            },
          ),
        );
      }
    }
  },
});

/**
 * The underlying data factory for frontmatter.
 *
 * You usually don't need this directly; prefer {@link ensureCodeFrontmatter}.
 */
export const codePartialNDF = codePartialDefn.factory;

/**
 * mdast `Code` node enriched with `data.codeFM`.
 */
export type CodePartialNode = NodeWithData<typeof codePartialDefn>;

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
export function codePartial(
  identity: string,
  flags: Record<string, unknown>,
  source: string,
  zodSchemaSpec?: Record<string, unknown>,
  init?: {
    registerIssue?: (message: string, content: string, error?: unknown) => void;
  },
): CodePartial {
  // Collect optional injection globs
  const injectGlobs = flags.inject === undefined
    ? []
    : Array.isArray(flags.inject)
    ? (flags.inject as string[])
    : [String(flags.inject)];

  const hasFlag = (k: string) =>
    k in flags && flags[k] !== false && flags[k] !== undefined;

  let hasPrepend = hasFlag("prepend");
  const hasAppend = hasFlag("append");
  if (!hasPrepend && !hasAppend) hasPrepend = true;

  const injection: CodePartial["injection"] = injectGlobs.length
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

  return codePartialSchema.parse({
    identity,
    argsZodSchema,
    argsZodSchemaSpec,
    source,
    content,
    injection,
  });
}
