// code-frontmatter.ts
import { globToRegExp } from "@std/path";
import { Code, Node } from "types/mdast";
import {
  getLanguageByIdOrAlias,
  type LanguageSpec,
} from "../../universal/code.ts";
import { flexiblePatterns } from "../../universal/flexible-pattern.ts";
import {
  DefaultsFlagPolicy,
  instructionsFromText,
  type InstructionsResult,
  type PosixStylePI,
  queryPosixPI,
} from "../../universal/posix-pi.ts";
import { dataBag } from "./data-bag.ts";

/**
 * Structured enrichment attached to a `code` node.
 *
 * A frontmatter string like:
 *
 * ```md
 * ```ts --tag alpha -L 9 { priority: 5 }
 * console.log("hi");
 * ```
 * ```
 *
 * is parsed into:
 * - `lang` / `langSpec`
 * - `pi` (processing instructions: flags + positional tokens)
 * - `attrs` (JSON5-like `{ ... }` tail)
 */
export interface CodeFrontmatter extends InstructionsResult {
  /** The language of the code fence (e.g. "ts", "bash"). */
  readonly lang?: string;
  /** The specification of the language code fence. */
  readonly langSpec?: LanguageSpec;

  /**
   * The raw `meta` string on the code fence.
   * Must be present and non-empty (after trimming) for the node to have
   * "code frontmatter".
   */
  readonly meta: string;

  /** Parsed Processing Instructions (flags / positional tokens). */
  readonly pi: PosixStylePI;

  /** Parsed JSON5 object from trailing `{ ... }` (if any). */
  readonly attrs?: Record<string, unknown>;

  /**
   * Which preset rules were applied when this CodeFrontmatter was created.
   * Empty when no presets matched (or no presets were provided).
   */
  readonly fromPresets: readonly CodeFrontmatterPresetRule[];
}

/**
 * A preset rule that can apply default flags/attrs to a code fence.
 *
 * - `meta` is a reference label only (not parsed).
 * - `codeFM` is the parsed preset “meta” (using `instructionsFromText`).
 * - `match` is a predicate receiving the `Code` node only.
 */
export interface CodeFrontmatterPresetRule {
  /** Human-readable label for debugging / provenance. */
  readonly meta: string;

  /**
   * Parsed representation of the preset’s meta using `instructionsFromText()`.
   * This is where default flags + attrs are sourced from.
   */
  readonly codeFM: InstructionsResult;

  /**
   * Whether this preset applies to the given code node.
   * No extra context is provided; everything needed is in `code`.
   */
  readonly match: (code: Code) => boolean;
}

/**
 * A set of presets to be evaluated in-order.
 */
export type CodeFrontmatterPresets = readonly CodeFrontmatterPresetRule[];

/**
 * Additional options for {@link codeFrontmatter}.
 *
 * These are passed through to {@link instructionsFromText}, plus an
 * extra flag controlling whether the result is cached on the node.
 */
export type CodeFrontmatterOptions =
  & Parameters<typeof instructionsFromText>[1]
  & {
    /**
     * If `true` (default), cache the parsed frontmatter on the `code` node
     * as `data.codeFM` so subsequent calls are O(1).
     *
     * If `false`, the node is never mutated and frontmatter is parsed on
     * every call.
     */
    readonly cacheableInCodeNodeData?: boolean;

    /**
     * If transform is passed in, first the lang and meta are allowed to be
     * interpolated or otherwise modified before use.
     */
    readonly transform?: (
      lang?: string | null | undefined,
      meta?: string | null | undefined,
    ) => false | {
      lang?: string | null | undefined;
      meta?: string | null | undefined;
    };

    /**
     * Preset rules that can contribute defaults (flags/attrs) prior to parsing.
     * Populated elsewhere and passed in here.
     */
    readonly presets?: CodeFrontmatterPresets;
  };

/**
 * Typed accessor for `code.data.codeFM`.
 */
const codeFmDataBag = dataBag<"codeFM", CodeFrontmatter, Code>("codeFM");

/* -------------------------------------------------------------------------- */
/* Preset plumbing                                                            */
/* -------------------------------------------------------------------------- */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Merge defaults attrs across presets (deep, later presets override earlier).
 * This is only “defaults across presets”. The policy for merging defaults with
 * parsed attrs is handled inside `posix-pi.ts` (attrsPolicy).
 */
function mergeDefaultsAttrsFromPresets(
  rules: readonly CodeFrontmatterPresetRule[],
): Record<string, unknown> | undefined {
  let any = false;
  const out: Record<string, unknown> = {};

  const deepMerge = (
    target: Record<string, unknown>,
    src: Record<string, unknown>,
  ) => {
    for (const [k, v] of Object.entries(src)) {
      const prev = target[k];
      if (isPlainObject(prev) && isPlainObject(v)) {
        deepMerge(prev, v);
      } else {
        target[k] = v;
      }
    }
  };

  for (const r of rules) {
    const a = r.codeFM.attrs;
    if (!a) continue;
    deepMerge(out, a);
    any = true;
  }

  return any ? out : undefined;
}

/**
 * Merge defaults flags across presets.
 *
 * NOTE: This is only “defaults across presets”. The policy for merging defaults
 * with parsed flags is handled inside `posix-pi.ts` (flagsPolicy).
 */
function mergeDefaultsFlagsFromPresets(
  rules: readonly CodeFrontmatterPresetRule[],
  flagsPolicy?: DefaultsFlagPolicy,
): Pick<PosixStylePI, "flags"> | undefined {
  let any = false;
  const out: PosixStylePI["flags"] = {};

  const appendValue = (prev: unknown, next: unknown) => {
    if (Array.isArray(prev)) return [...prev, next];
    if (prev === undefined) return next;
    return [prev, next];
  };

  const appendAcrossPresetsKeys = new Set(["tag"]); // keep tiny for now

  for (const r of rules) {
    const f = r.codeFM.pi?.flags;
    if (!f) continue;

    for (const [k, v] of Object.entries(f)) {
      const shouldAppendAcrossPresets = flagsPolicy === "append" &&
        appendAcrossPresetsKeys.has(k);

      if (shouldAppendAcrossPresets) {
        out[k] = appendValue(out[k], v) as typeof out[string];
      } else {
        // across presets: last wins (even when flagsPolicy is "append")
        out[k] = v as typeof out[string];
      }

      any = true;
    }
  }

  return any ? { flags: out } : undefined;
}

function matchingPresetRules(
  code: Code,
  presets?: CodeFrontmatterPresets,
): readonly CodeFrontmatterPresetRule[] {
  if (!presets?.length) return [];
  const applied: CodeFrontmatterPresetRule[] = [];
  for (const r of presets) {
    if (r.match(code)) applied.push(r);
  }
  return applied;
}

/* -------------------------------------------------------------------------- */
/* Presets factory (stateful)                                                 */
/* -------------------------------------------------------------------------- */

export interface CodeFrontmatterPresetsFactoryOptions {
  /**
   * Options used when parsing the preset meta tail via `instructionsFromText()`,
   * and also when extracting identity from a code node’s `(lang + meta)` string.
   */
  readonly instrOptions?: Parameters<typeof instructionsFromText>[1];

  /**
   * Options forwarded into glob matching for identity glob patterns.
   */
  readonly glob?: Parameters<typeof globToRegExp>[1];
}

export interface CodeFrontmatterPresetsFactory {
  parseRulesFromText(text: string): readonly CodeFrontmatterPresetRule[];
  catalogRulesFromText(text: string): void;
  matchingRules(code: Code): readonly CodeFrontmatterPresetRule[];
  readonly catalog: readonly CodeFrontmatterPresetRule[];
}

/**
 * Stateful presets factory.
 *
 * Preset parsing shortcuts (now powered by flexible-pattern.ts):
 * - `*` means match-all (for both <lang-pattern> and <identity-pattern>)
 * - `/.../` means regex
 * - `!/ ... /` means negated regex
 * - `!glob` means negated glob (for identity; and also supported for lang, though lang defaults to exact)
 */
export function presetsFactory(
  options: CodeFrontmatterPresetsFactoryOptions = {},
): CodeFrontmatterPresetsFactory {
  const instrOptions = options.instrOptions ?? { coerceNumbers: true };
  const globOpts = options.glob;

  const catalog: CodeFrontmatterPresetRule[] = [];

  // Language patterns: default exact (so "sql" matches exactly),
  // but allow "*" and /re/ and !/re/.
  const langFP = flexiblePatterns({
    trim: true,
    allowNegation: true,
    allowQuotedExact: true,
    defaultKind: "exact",
    preferExactWhenNoGlobMeta: true,
  });

  // Identity patterns: default glob (so "*.sql" works),
  // also allow "*" and /re/ and negations.
  const idFP = flexiblePatterns({
    trim: true,
    allowNegation: true,
    allowQuotedExact: true,
    defaultKind: "glob",
    preferExactWhenNoGlobMeta: false, // treat "foo.sql" as glob by default (caller can still quote for exact)
    glob: globOpts,
  });

  const codeIdentity = (code: Code): string | undefined => {
    const lang = code.lang ?? "";
    const meta = code.meta ?? "";
    const command = `${lang} ${meta}`.trim();
    if (!command) return undefined;

    const ir = instructionsFromText(command, instrOptions);
    const q = queryPosixPI(ir.pi, ir.attrs, {
      normalizeFlagKey: instrOptions.normalizeFlagKey,
    });

    // Identity is the first bare word after cmdLang (excluding flag values).
    return q.getFirstBareWord();
  };

  // inside presetsFactory(...)

  const api: CodeFrontmatterPresetsFactory = {
    // KEEP AS IS: pure parse, no catalog side-effects.
    parseRulesFromText(text: string): readonly CodeFrontmatterPresetRule[] {
      const rules: CodeFrontmatterPresetRule[] = [];
      const lines = text.split(/\r?\n/);

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith("#")) continue;
        if (line.startsWith("//")) continue;

        /**
         * Preset rule authoring format (what users write):
         *
         *   <lang-pattern> <identity-pattern> <meta...>
         *
         * Examples:
         *
         *   sql *.sql --tag default --stage prod
         *   * *.md --render markdown
         *   /sq.*\/ !*.tmp --optimize
         *   ts foo.ts --level 3 { strict: true }
         *
         * There is NO required keyword like `preset` in authoring syntax.
         */

        const m = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
        if (!m) continue;

        const [, langPatRaw, idPatRaw, meta] = m;

        /**
         * Language pattern:
         *   - exact by default ("sql")
         *   - "*" matches all languages
         *   - "/re/" regex
         *   - "!/re/" negated regex
         */
        const langPat = langFP.parse(langPatRaw);

        /**
         * Identity pattern:
         *   - glob by default ("*.sql")
         *   - "*" matches all identities
         *   - "/re/" regex
         *   - "!*.sql" negated glob
         *   - "!/re/" negated regex
         *
         * Identity is derived from the first bare token in `(lang + meta)`
         * on the actual code fence, e.g.:
         *
         *   ```sql foo.sql --tag live
         *   ```
         *   → identity = "foo.sql"
         */
        const idPat = idFP.parse(idPatRaw);

        const metaLabel = line;

        /**
         * IMPORTANT: Simulation for instructionsFromText
         *
         * instructionsFromText() treats the FIRST token as `cmdLang`.
         * If meta starts with `--flag`, that flag would otherwise be
         * misinterpreted as `cmdLang` and discarded.
         *
         * To avoid forcing authors to write:
         *
         *   sql *.sql preset --tag default
         *
         * we SIMULATE a stable command prefix internally:
         *
         *   Author writes:
         *     sql *.sql --tag default --stage prod
         *
         *   We simulate parsing as if the text were:
         *     "code PRESET --tag default --stage prod"
         *
         * This ensures:
         *   - all flags are parsed correctly
         *   - no author-facing boilerplate
         *   - consistent behavior with real code fences
         */
        const codeFM = instructionsFromText(
          `code PRESET ${meta}`,
          instrOptions,
        );

        /**
         * Match predicate:
         *   - language pattern is tested against `code.lang`
         *   - identity pattern is tested against derived identity
         *   - BOTH must match for the preset to apply
         */
        const match = (code: Code) => {
          const codeLang = (code.lang ?? "").trim();
          const ident = codeIdentity(code) ?? "";

          if (!langFP.test(langPat, codeLang)) return false;
          return idFP.test(idPat, ident);
        };

        rules.push({ meta: metaLabel, codeFM, match });
      }

      return rules;
    },

    catalogRulesFromText(text: string): void {
      const parsed = api.parseRulesFromText(text);
      for (const r of parsed) catalog.push(r);
    },

    matchingRules(code: Code): readonly CodeFrontmatterPresetRule[] {
      if (!catalog.length) return [];
      const applied: CodeFrontmatterPresetRule[] = [];
      for (const r of catalog) {
        if (r.match(code)) applied.push(r);
      }
      return applied;
    },

    get catalog() {
      return catalog;
    },
  };

  return api;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Parse a single mdast `code` node into {@link CodeFrontmatter}, caching it
 * along the way.
 *
 * Parsing behavior:
 * - If `node.meta` is missing or whitespace-only, returns `null`.
 * - The "command string" passed to {@link instructionsFromText} is
 *   `${node.lang ?? ""} ${node.meta}` (trimmed), so the language identifier
 *   participates in PI parsing (e.g. `ts --tag alpha`).
 *
 * Caching behavior:
 * - When `options.cacheableInCodeNodeData !== false`, the parsed
 *   {@link CodeFrontmatter} is stored on the node as `data.codeFM` and
 *   reused on future calls.
 *
 * Presets behavior:
 * - If `options.presets` is provided, matching rules are collected.
 * - Their parsed `codeFM.pi.flags` and `codeFM.attrs` are passed into
 *   `instructionsFromText(..., { defaults: ... })`.
 * - The applied rules are recorded on the returned `CodeFrontmatter.fromPresets`.
 *
 * @param node    An mdast `code` node (or any node; non-code is ignored).
 * @param options Options forwarded to {@link instructionsFromText}, plus
 *                `cacheableInCodeNodeData` to control caching.
 * @returns Parsed {@link CodeFrontmatter}, or `null` if `meta` is empty.
 */
export function codeFrontmatter(
  node: Node,
  options?: CodeFrontmatterOptions,
): CodeFrontmatter | null {
  // Guard: must be a `code` node.
  if (!node || node.type !== "code") return null;
  const code = node as Code;

  let codeLang = code.lang;
  let codeMeta = code.meta;
  if (options?.transform) {
    const newValues = options.transform(code.lang, code.meta);
    if (newValues) {
      codeLang = newValues.lang;
      codeMeta = newValues.meta;
    }
  }

  const rawMeta = codeMeta ?? "";
  if (rawMeta.trim().length === 0) return null;

  const {
    cacheableInCodeNodeData = true,
    presets,
    ...instrOptions
  } = options ?? {};

  // Try to reuse cached frontmatter, if present.
  if (cacheableInCodeNodeData && codeFmDataBag.is(code)) {
    return (code.data as Record<string, unknown> & { codeFM: CodeFrontmatter })
      .codeFM;
  }

  const callerDefaults =
    (instrOptions as Parameters<typeof instructionsFromText>[1])
      ?.defaults;

  // Collect presets and compute defaults (if any)
  const appliedPresets = matchingPresetRules(code, presets);
  const defaultsFlags = mergeDefaultsFlagsFromPresets(
    appliedPresets,
    callerDefaults?.flagsPolicy,
  );
  const defaultsAttrs = mergeDefaultsAttrsFromPresets(appliedPresets);

  // Preserve original parsing behavior: lang participates by being prefixed.
  const command = `${codeLang ?? ""} ${rawMeta}`.trim();

  const ir = instructionsFromText(
    command,
    {
      ...(instrOptions as Parameters<typeof instructionsFromText>[1]),
      defaults: (defaultsFlags || defaultsAttrs)
        ? {
          // base defaults sourced from presets
          pi: defaultsFlags,
          attrs: defaultsAttrs,

          // caller-controlled behavior for defaults merge policy
          flagsPolicy: callerDefaults?.flagsPolicy,
          attrsPolicy: callerDefaults?.attrsPolicy,
          returnAttrsWhenDefaulted: callerDefaults?.returnAttrsWhenDefaulted,
        }
        : callerDefaults,
    },
  );

  const lang = code.lang || undefined;

  const codeFM: CodeFrontmatter = {
    lang,
    langSpec: lang ? getLanguageByIdOrAlias(lang) : undefined,
    meta: rawMeta,
    ...ir,
    fromPresets: appliedPresets,
  };

  if (cacheableInCodeNodeData) {
    codeFmDataBag.attach(code, codeFM);
  }

  return codeFM;
}
