import { globToRegExp, isGlob, normalize } from "@std/path";
import z from "@zod/zod";
import { safeInterpolate } from "../../interpolate/safe.ts";
import { gitignore } from "../../universal/gitignore.ts";
import {
  flexibleTextSchema,
  mergeFlexibleText,
} from "../../universal/posix-pi.ts";
import {
  Content,
  InjectionProvider,
  Interpolator,
  Memory,
} from "../../universal/render.ts";
import { ensureTrailingNewline } from "../../universal/text-utils.ts";
import { Directive } from "../projection/directives.ts";
import {
  Executable,
  isMaterializable,
  Materializable,
} from "../projection/playbook.ts";
import {
  ActionableCodePiFlags,
  CaptureSpec,
} from "../remark/actionable-code-candidates.ts";

export const partialTmplPiFlagsSchema = z.object({
  descr: z.string().optional(),
  inject: flexibleTextSchema.optional(),
  prepend: z.boolean().optional(),
  append: z.boolean().optional(),
}).transform((raw) => {
  const inject = mergeFlexibleText(raw.inject);
  let regExes: RegExp[] = [];
  let injectAll: boolean = false;
  if (inject.length == 1 && (inject[0] == "**/*" || inject[0] == "*")) {
    injectAll = true;
  } else {
    regExes = inject.map((glob) => {
      if (!isGlob(glob)) {
        const exact = normalize(glob).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`^${exact}$`);
      }
      return globToRegExp(glob, {
        extended: true,
        globstar: true,
        caseInsensitive: false,
      });
    });
  }
  return {
    description: raw.descr,
    inject: inject.length > 0 ? inject : false as const,
    injectAll,
    regExes: inject.length > 0 ? regExes : false as const,
    prepend: raw.prepend ?? false,
    append: raw.append ?? false,
  };
});

export type PartialTmplPiFlags = z.infer<typeof partialTmplPiFlagsSchema>;

export type PartialTmpl =
  & Directive
  & { readonly args: PartialTmplPiFlags }
  & Partial<InjectionProvider<Executable | Materializable>>;

export function partialTmpl(d: Directive): PartialTmpl | false {
  const parsedArgs = z.safeParse(
    partialTmplPiFlagsSchema,
    d.instructions.pi.flags,
  );
  if (parsedArgs.success) {
    const { data: args } = parsedArgs;
    let inject: PartialTmpl["inject"] = undefined;
    if (args.injectAll || args.regExes) {
      const { injectAll, regExes, append } = args;
      inject = injectAll
        ? ((ctx) =>
          append ? `${ctx.body}\n${d.value}` : `${d.value}\n${ctx.body}`)
        : (ctx) => {
          if (ctx.path && regExes) {
            for (const re of regExes) {
              if (re.test(ctx.path)) {
                return append
                  ? `${ctx.body}\n${d.value}`
                  : `${d.value}\n${ctx.body}`;
              }
            }
          }
        };
    }
    return { ...d, args, inject };
  }
  return false;
}

export type FlexibleMemoryValue = unknown;
export type FlexibleMemoryShape = Record<string, FlexibleMemoryValue>;

export type Capturable = ActionableCodePiFlags["capture"];

export type Captured = {
  readonly spec: CaptureSpec;
  readonly text: () => string;
  readonly json: <Value>() => Value;
};

export function flexibleMemory(
  directives: readonly Directive[],
  captures?: Record<string, Captured>,
): Memory<FlexibleMemoryValue, FlexibleMemoryShape, Capturable> & {
  partials: Record<string, PartialTmpl>;
} {
  const injectables = {
    all: [] as [string, PartialTmpl][],
    regExes: [] as [string, PartialTmpl][],
  };
  const partials: Record<string, PartialTmpl> = {};

  for (const d of directives) {
    if (d.directive === "PARTIAL" && d.identity) {
      const partial = partialTmpl(d);
      if (partial) {
        partials[d.identity] = partial;
        if (partial.args.injectAll) {
          injectables.all.push([d.identity, partial]);
        } else if (partial.args.regExes) {
          injectables.regExes.push([d.identity, partial]);
        }
      }
    }
  }

  const memoize: Memory<
    FlexibleMemoryValue,
    FlexibleMemoryShape,
    Capturable
  >["memoize"] = async (
    rendered,
    capture,
  ) => {
    for (const cs of capture) {
      const cap: Captured = {
        spec: cs,
        text: () => rendered,
        json: <Value>() => JSON.parse(rendered) as Value,
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
      } else {
        if (captures) captures[cs.key] = cap;
      }
    }
  };

  return {
    get: (name) => partials[name],
    // the more specific (regExes ones) come first because "all" is higher precendence;
    // injectables are "wrapping" inward to outward
    injectables: () => [...injectables.regExes, ...injectables.all],
    memoize,
    partials,
  };
}

export function actionableContent(): Content<
  Executable | Materializable,
  Capturable
> {
  return {
    body: (code) => code.value,
    path: (code) =>
      isMaterializable(code)
        ? code.materializableIdentity
        : code.spawnableIdentity,
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
        ? code.materializationArgs.capture
        : code.spawnableArgs.capture,
  };
}

export function renderStrategy(
  directives: readonly Directive[],
  strategyOpts?: {
    globals?: Record<string, unknown>;
    captures?: Record<string, Captured>;
  },
) {
  return {
    content: actionableContent(),
    interpolator: {
      interpolate: (input, interpOpts) => {
        return {
          text: safeInterpolate(input, {
            ...interpOpts.globals,
            ...interpOpts.locals,
          }, {
            brackets: [{ id: "typical", prefix: "$", open: "{", close: "}" }],
            functions: {
              unsafeEval: ([code]) => eval(String(code)),
            },
          }),
        };
      },
    } satisfies Interpolator<
      Materializable | Executable,
      FlexibleMemoryValue,
      FlexibleMemoryShape,
      Capturable
    >,
    memory: flexibleMemory(directives, strategyOpts?.captures),
    globals: strategyOpts?.globals,
  };
}
