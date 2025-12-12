import { globToRegExp, isGlob, normalize } from "@std/path";
import z from "@zod/zod";
import { Code } from "types/mdast";
import {
  SafeBracketSpec,
  safeInterpolateAsync,
  SafeInterpolationFunctionRegistry,
} from "../../universal/flexible-interpolator.ts";
import { gitignore } from "../../universal/gitignore.ts";
import {
  flexibleTextSchema,
  instructionsFromText,
  mergeFlexibleText,
} from "../../universal/posix-pi.ts";
import {
  Content,
  InjectionProvider,
  Interpolator,
  Memory,
} from "../../universal/render.ts";
import { ensureTrailingNewline } from "../../universal/text-utils.ts";
import { safeJsonStringify } from "../../universal/tmpl-literal-aide.ts";
import { unsafeJsExpr } from "../../universal/unsafe-js-expr.ts";
import { build as zodSchemaFromUserAgent } from "../../universal/zod-aide.ts";
import {
  Executable,
  isMaterializable,
  Materializable,
} from "../projection/playbook.ts";
import {
  ActionableCodePiFlags,
  CaptureSpec,
} from "../remark/actionable-code-candidates.ts";
import { codeFrontmatter } from "./code-frontmatter.ts";

export const partialTmplPiFlagsSchema = z.object({
  descr: z.string().optional(),
  inject: flexibleTextSchema.optional(),
  prepend: z.boolean().optional(),
  append: z.boolean().optional(),
  weight: z.union([z.number(), z.string()]).optional().default(99),
}).transform((raw) => {
  const inject = mergeFlexibleText(raw.inject);
  const weight = typeof raw.weight === "string"
    ? Number(raw.weight)
    : raw.weight;
  let injectRules: {
    readonly nature: "regex" | "regex-negative" | "glob" | "auto";
    readonly regExp: RegExp;
    readonly from: string;
    readonly weight: number;
  }[] = [];
  let injectAll: boolean = false;
  if (inject.length == 1 && (inject[0] == "**/*" || inject[0] == "*")) {
    injectAll = true;
  } else {
    injectRules = inject.map((glob) => {
      if (
        (glob.startsWith("/") || glob.startsWith("!/")) && glob.endsWith("/")
      ) {
        const strictRegEx = glob.slice(0, glob.length - 1); // strip the slash
        if (glob.startsWith("!/")) {
          const regExp = new RegExp(strictRegEx.slice(2));
          return {
            nature: "regex-negative",
            regExp,
            from: glob,
            weight,
          };
        }
        const regExp = new RegExp(strictRegEx.slice(1));
        return { nature: "regex", regExp, from: glob, weight };
      }
      if (!isGlob(glob)) {
        const exact = normalize(glob).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return {
          nature: "auto",
          regExp: new RegExp(`^${exact}$`),
          from: glob,
          weight,
        };
      }
      return {
        nature: "glob",
        regExp: globToRegExp(glob, {
          extended: true,
          globstar: true,
          caseInsensitive: false,
        }),
        from: glob,
        weight,
      };
    });
  }
  return {
    description: raw.descr,
    inject: inject.length > 0 ? inject : false as const,
    injectAll,
    injectRegExes: inject.length > 0
      ? injectRules.filter((ir) => ir.nature !== "regex-negative").map((ir) =>
        ir.regExp
      )
      : false as const,
    donotInjectRegExes: inject.length > 0
      ? injectRules.filter((ir) => ir.nature === "regex-negative").map((ir) =>
        ir.regExp
      )
      : false as const,
    injectRules,
    prepend: raw.prepend ?? false,
    append: raw.append ?? false,
    weight,
  };
});

export type PartialTmplPiFlags = z.infer<typeof partialTmplPiFlagsSchema>;

export const PARTIAL = "PARTIAL" as const;
export type PARTIAL = typeof PARTIAL;

export type PartialTmpl =
  & Code
  & {
    readonly directive: PARTIAL;
    readonly identity: string;
    readonly piFlags: PartialTmplPiFlags;
    readonly argsSchema?: z.ZodTypeAny;
    readonly render: (locals?: unknown) => { text: string; error?: unknown };
  }
  & Partial<InjectionProvider<Executable | Materializable>>;

export function partialTmpl(identity: string, code: Code): PartialTmpl | false {
  const codeFM = codeFrontmatter(code);
  if (!codeFM) return false;

  const argsSchema: PartialTmpl["argsSchema"] = codeFM.attrs
    ? zodSchemaFromUserAgent({
      type: "object",
      properties: codeFM.attrs,
      additionalProperties: true,
    })
    : undefined;
  const parsedPiFlags = z.safeParse(partialTmplPiFlagsSchema, codeFM.pi.flags);
  if (parsedPiFlags.success) {
    const { data: piFlags } = parsedPiFlags;
    let inject: PartialTmpl["inject"] = undefined;
    let injectionDiagnostics: PartialTmpl["injectionDiagnostics"] = undefined;

    if (
      piFlags.injectAll || piFlags.injectRegExes || piFlags.donotInjectRegExes
    ) {
      const {
        injectAll,
        injectRules,
        injectRegExes,
        donotInjectRegExes,
        append,
      } = piFlags;
      inject = injectAll
        ? ((ctx) =>
          append ? `${ctx.body}\n${code.value}` : `${code.value}\n${ctx.body}`)
        : (ctx) => {
          if (ctx.path && donotInjectRegExes) {
            for (const re of donotInjectRegExes) {
              if (re.test(ctx.path)) {
                // check for negations first and bail early if we shouldn't inject
                return undefined;
              }
            }
          }

          if (ctx.path && injectRegExes) {
            for (const re of injectRegExes) {
              if (re.test(ctx.path)) {
                return append
                  ? `${ctx.body}\n${code.value}`
                  : `${code.value}\n${ctx.body}`;
              }
            }
          }
        };
      injectionDiagnostics = injectAll
        ? ((ctx, diags) => {
          if (ctx.path) {
            diags.push({
              target: ctx.path,
              inject: true,
              why: `PARTIAL ${identity}: matches injectAll`,
              how: append ? "append" : "prepend",
            });
          }
        })
        : (ctx, diags) => {
          if (ctx.path && injectRules) {
            for (
              const ir of injectRules.filter((ir) =>
                ir.nature === "regex-negative"
              )
            ) {
              if (ir.regExp.test(ctx.path)) {
                diags.push({
                  target: ctx.path,
                  inject: false,
                  why:
                    `PARTIAL ${identity}: ${ir.regExp} (${ir.nature}: ${ir.from})`,
                  how: append ? "append" : "prepend",
                  weight: ir.weight,
                });
                return;
              }
            }
            for (
              const ir of injectRules.filter((ir) =>
                ir.nature !== "regex-negative"
              )
            ) {
              if (ir.regExp.test(ctx.path)) {
                diags.push({
                  target: ctx.path,
                  inject: true,
                  why:
                    `PARTIAL ${identity}: ${ir.regExp} (${ir.nature}: ${ir.from})`,
                  how: append ? "append" : "prepend",
                  weight: ir.weight,
                });
              }
            }
          }
        };
    }
    const render: PartialTmpl["render"] = (locals) => {
      if (argsSchema) {
        const parsed = argsSchema.safeParse(locals);
        if (!parsed.success) {
          // deno-fmt-ignore
          const message = `partial "${identity}" arguments invalid: ${z.prettifyError(parsed.error)})`;
          return { text: message, error: new Error(message) };
        }
      }
      return { text: code.value };
    };
    return {
      ...code,
      directive: PARTIAL,
      identity,
      piFlags,
      inject,
      injectionDiagnostics,
      argsSchema,
      render,
    };
  }
  return false;
}

export type FlexibleMemoryValue = unknown;
export type FlexibleMemoryShape = Record<string, FlexibleMemoryValue>;

export type Capturable = {
  readonly identity: string;
  readonly captureSpecs: ActionableCodePiFlags["capture"];
};

export type Captured = {
  readonly spec: CaptureSpec;
  readonly text: () => string;
  readonly json: <Value>() => Value;
  readonly toString: () => string; // defaults to text()
};

export type FlexibleMemory =
  & Memory<FlexibleMemoryValue, FlexibleMemoryShape, Capturable>
  & {
    readonly partials: Record<string, PartialTmpl>;
    readonly memoizedFsPaths: (Extract<CaptureSpec, { nature: "relFsPath" }> & {
      readonly captured: Captured;
    })[];
  };

export function flexibleMemory(
  partialTmplCandidates: Iterable<
    Code & { readonly directive: string; readonly identity?: string }
  >,
  memoized?: Record<string, Captured>,
): FlexibleMemory {
  const memoizedFsPaths: FlexibleMemory["memoizedFsPaths"] = [];
  const injectables = {
    donotInjectRegExes: [] as [string, PartialTmpl][],
    injectRegExes: [] as [string, PartialTmpl][],
    all: [] as [string, PartialTmpl][],
  };
  const partials: Record<string, PartialTmpl> = {};

  for (const ptc of partialTmplCandidates) {
    if (ptc.directive === PARTIAL && ptc.identity) {
      const partial = partialTmpl(ptc.identity, ptc);
      if (partial) {
        partials[ptc.identity] = partial;
        if (partial.piFlags.injectAll) {
          injectables.all.push([ptc.identity, partial]);
        } else if (partial.piFlags.donotInjectRegExes) {
          injectables.donotInjectRegExes.push([ptc.identity, partial]);
        } else if (partial.piFlags.injectRegExes) {
          injectables.injectRegExes.push([ptc.identity, partial]);
        }
      }
    }
  }
  // lower weight is more important
  injectables.donotInjectRegExes.sort((a, b) =>
    b[1].piFlags.weight - a[1].piFlags.weight
  );
  injectables.injectRegExes.sort((a, b) =>
    b[1].piFlags.weight - a[1].piFlags.weight
  );
  injectables.all.sort((a, b) => b[1].piFlags.weight - a[1].piFlags.weight);

  const memoize: Memory<
    FlexibleMemoryValue,
    FlexibleMemoryShape,
    Capturable
  >["memoize"] = async (rendered, capCandidates) => {
    if (!capCandidates || !capCandidates.captureSpecs) return;
    for (const cs of capCandidates.captureSpecs) {
      const cap: Captured = {
        spec: cs,
        text: () => rendered,
        json: <Value>() => JSON.parse(rendered) as Value,
        toString: () => rendered.trim(),
      };
      if (cs.nature === "relFsPath") {
        await Deno.writeTextFile(
          cs.fsPath,
          ensureTrailingNewline(cap.text()),
        );

        const { gitignore: ignore } = cs;
        if (ignore) {
          // We expect fsPath to be something like "./path/to/file".
          // For .gitignore we usually want a repo-relative path.
          const gi = cs.fsPath.slice("./".length);
          if (typeof ignore === "string") {
            await gitignore(gi, ignore);
          } else {
            await gitignore(gi);
          }
        }
        memoizedFsPaths.push({ ...cs, captured: cap });
      } else {
        if (memoized) memoized[cs.key ?? capCandidates.identity] = cap;
      }
    }
  };

  return {
    get: (name) => partials[name],
    // the more specific (injectRegExes ones) come first because "all" is higher precendence;
    // injectables are "wrapping" inward to outward
    injectables: () => [
      ...injectables.donotInjectRegExes,
      ...injectables.injectRegExes,
      ...injectables.all,
    ],
    memoize,
    partials,
    memoizedFsPaths,
  };
}

export function actionableContent(): Content<
  Executable | Materializable,
  Capturable
> {
  const identity = (code: Executable | Materializable) =>
    isMaterializable(code)
      ? code.materializableIdentity
      : code.spawnableIdentity;
  return {
    body: (code) => code.value,
    path: identity,
    isInterpolatable: (code) =>
      isMaterializable(code)
        ? code.materializationArgs.interpolate ?? false
        : code.spawnableArgs.interpolate ?? false,
    isInjectable: (_path, code) =>
      isMaterializable(code)
        ? code.materializationArgs.injectable ?? false
        : code.spawnableArgs.injectable ?? false,
    isMemoizable: (code: Executable | Materializable) =>
      isMaterializable(code)
        ? {
          identity: identity(code),
          captureSpecs: code.materializationArgs.capture,
        }
        : {
          identity: identity(code),
          captureSpecs: code.spawnableArgs.capture,
        },
    locals: (action) => ({ identity: identity(action), action }),
  };
}

export const safeExprCodeBID = "safe" as const;
export const partialTmplCodeBID = "partial" as const;
export const unsafeCodeBID = "unsafe" as const;
export type CodeInterpBracketID =
  | typeof safeExprCodeBID
  | typeof partialTmplCodeBID
  | typeof unsafeCodeBID;

export function codeInterpolationStrategy(
  partialTmplCandidates: Iterable<
    Code & { readonly directive: string; readonly identity?: string }
  >,
  strategyOpts?: {
    approach?: "safe-only" | "safety-first" | "unsafe-allowed";
    unsafeGlobalsCtxName?: string;
    globals?: Record<string, unknown>;
    safeFunctions?: SafeInterpolationFunctionRegistry;
    memoized?: Record<string, Captured>;
  },
) {
  const memoized = strategyOpts?.memoized ?? {};
  const memory = flexibleMemory(partialTmplCandidates, memoized);
  const {
    approach = "safe-only",
    unsafeGlobalsCtxName = "ctx",
    safeFunctions: functions,
  } = strategyOpts ?? {};

  const onRawExpr = "onMissing" as const;
  let brackets: SafeBracketSpec[];
  switch (approach) {
    case "safe-only": {
      brackets = [
        { id: safeExprCodeBID, prefix: "$", open: "{", close: "}", functions },
        { id: partialTmplCodeBID, open: "{{", close: "}}" },
      ];
      break;
    }
    case "safety-first": {
      brackets = [
        { id: safeExprCodeBID, prefix: "$", open: "{", close: "}", functions },
        { id: partialTmplCodeBID, open: "{{", close: "}}", onRawExpr },
        { id: unsafeCodeBID, prefix: "$!", open: "{", close: "}", onRawExpr },
      ];
      break;
    }
    case "unsafe-allowed": {
      brackets = [
        { id: unsafeCodeBID, prefix: "$", open: "{", close: "}", onRawExpr },
        { id: partialTmplCodeBID, open: "{{", close: "}}", onRawExpr },
      ];
      break;
    }
  }

  const interpolate: Interpolator<
    Materializable | Executable,
    FlexibleMemoryValue,
    FlexibleMemoryShape,
    Capturable
  >["interpolate"] = async (input, interpOpts) => {
    const interpolatedPartial = async (
      name: string,
      partialTmplArgs?: Record<string, unknown>,
    ) => {
      const partial = memory.partials[name];
      if (partial) {
        const rendered = partial.render(partialTmplArgs);
        if (rendered.error) return rendered.text;
        const result = await interpolate(rendered.text, {
          ...interpOpts,
          locals: {
            PARTIAL: partial,
            ...interpOpts.locals,
            ...partialTmplArgs,
          },
        });
        return result.text;
      }
      // deno-fmt-ignore
      return `partial "${name}" not found (available: ${Object.keys(memory.partials).map(p => `'${p}'`).join(", ")})`;
    };

    return {
      text: await safeInterpolateAsync(input, {
        ...interpOpts.globals, // in typical "safe" interpolators globals and locals are the same
        ...interpOpts.locals,
        captured: memoized,
        memoized,
      }, {
        brackets,
        onMissing: async (expr, info) => {
          switch (info.bracketID as CodeInterpBracketID) {
            case "safe":
              return `\$?{${expr}}`;
            case "partial": {
              const ir = instructionsFromText(expr);
              return interpolatedPartial(ir.pi.args[0], ir.attrs);
            }
            case "unsafe": {
              try {
                const unsafeJsExprLocals = {
                  ...interpOpts.locals,
                  safeJsonStringify,
                  captured: memoized,
                  memoized,
                  partial: interpolatedPartial, // dynamically call a partial
                };
                const fn = unsafeJsExpr(
                  expr,
                  unsafeGlobalsCtxName, // `ctx.*` allows access to the "globals" properties
                  Object.keys(unsafeJsExprLocals),
                );
                return await fn(
                  interpOpts.globals,
                  unsafeJsExprLocals,
                ) as string;
              } catch (err) {
                return `$!{ERROR(unsafe): ${String(err)}}`;
              }
            }
          }
        },
      }),
    };
  };

  return {
    content: actionableContent(),
    interpolator: { interpolate },
    memory,
    globals: strategyOpts?.globals,
    captured: memoized,
    memoized,
  };
}
