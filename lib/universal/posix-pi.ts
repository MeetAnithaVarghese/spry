/**
 * @module posix-pi
 *
 * POSIX-style parser for `cmd/lang + meta` strings, typically used with
 * Markdown code fence info strings (e.g. ```` ```ts PARTIAL main --tag ok { ... } ``` ````).
 *
 * This module:
 * - Treats the first CLI token as a `cmd/lang` hint.
 * - Parses the "command-line" portion (before the first unquoted `{`) using
 *   POSIX-like tokenization (whitespace, quotes, escapes).
 * - Interprets tokens as flags, positional keys, and boolean markers.
 * - Treats everything from the first unquoted `{` to the end as pure JSON5
 *   configuration (attrs), not part of the POSIX CLI.
 *
 * For usage patterns and edge cases, see the tests in `posix-pi_test.ts`.
 */
import z from "@zod/zod";
import JSON5 from "json5";

/**
 * POSIX-style processing instruction (PI) extracted from a `cmd/lang + meta` string.
 *
 * This represents the parsed token stream and normalized flags from the
 * non-JSON portion of a Markdown code-fence info string, e.g.:
 *
 *   ```js PARTIAL main --level=2 --name "hello world" { id: "foo" }
 *   ^^^^ ^^^^^^^^^^^^ ^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^
 *  cmd/    tokens        flags           flags              attrs
 *  lang
 *   ```
 *
 * The first token is treated as a **command / language hint** (`cmd/lang`).
 * By default it is excluded from flag / positional parsing, but it is
 * available separately in the result as `cmdLang`.
 *
 * The JSON5 `{ ... }` block, if present, is returned separately as `attrs`.
 */
export interface PosixStylePI {
  /**
   * Raw token stream split from the **CLI portion only** (i.e. before
   * the first unquoted `{`), using POSIX-like tokenization:
   *
   * - Whitespace separates tokens;
   * - Single and double quotes group text and are not included in tokens;
   * - A backslash escapes the next character (outside or inside double quotes).
   *
   * Note: tokens from the JSON5 `{ ... }` block are **not** included here.
   */
  args: string[];
  /**
   * Positional tokens (normalized).
   *
   * When the default behavior is used (see `retainCmdLang`), this excludes
   * the leading `cmd/lang` token.
   *
   * Contains:
   * - normalized flag keys for two-token flags
   *   (e.g. "`--key value`" -> `"key"`);
   * - bare tokens (no leading dashes), normalized via `normalizeFlagKey`
   *   when provided.
   */
  pos: string[];
  /**
   * Mapping of normalized flag key -> value.
   *
   * Single occurrences are stored as:
   * - boolean for bare flags (e.g. `--verbose`),
   * - string or number for key-value flags.
   *
   * Repeated occurrences of the same key accumulate into arrays:
   *   `--tag a --tag=b --tag c`  ->  `flags.tag = ["a", "b", "c"]`
   */
  flags: Record<
    string,
    string | number | boolean | (string | number | boolean)[]
  >;
  /** Count of tokens in `args` (CLI tokens only). */
  count: number;
  /** Count of tokens in `pos`. */
  posCount: number;
}

/**
 * Result of `instructionsFromText`.
 *
 * This wraps the POSIX-style PI plus richer, higher-level context about
 * how the string was interpreted.
 */
export interface InstructionsResult {
  /** Parsed POSIX-style PI for the **command-line portion only**. */
  pi: PosixStylePI;
  /** Parsed JSON5 attrs object, if a `{ ... }` block was present. */
  attrs?: Record<string, unknown>;
  /**
   * First token from the CLI portion, treated as a "command / language hint".
   *
   * For code fences, this is typically the language (e.g. `"ts"` or `"sql"`),
   * but may be any arbitrary command-like string.
   */
  cmdLang?: string;
  /**
   * Raw CLI text that was tokenized for PI parsing, i.e. the substring
   * before the first unquoted `{` (or the entire string if no attrs block).
   */
  cli: string;
  /**
   * Raw JSON5 text handed to the JSON5 parser, i.e. the substring starting
   * at the first unquoted `{` (including that brace), or `undefined` when
   * no attrs block was found.
   *
   * This text is **not** tokenized POSIX-style; it is treated as pure JSON5.
   */
  attrsText?: string;
}

/**
 * Internal: single-pass scan of the info string.
 *
 * Responsibilities:
 * - Trim the input.
 * - POSIX-style tokenize **only the CLI portion** (before the first unquoted `{`).
 * - Detect the first unquoted `{` and slice out:
 *   - `cli` (text before it),
 *   - `attrsText` (text from it to the end).
 *
 * Everything after the first unquoted `{` is treated as pure JSON5 and is
 * **not** tokenized or processed as POSIX CLI.
 */
function scanInfoString(text: string): {
  cliTokens: string[];
  cli: string;
  attrsText?: string;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { cliTokens: [], cli: "" };
  }

  const tokens: string[] = [];

  type State = "OUT" | "SINGLE" | "DOUBLE";
  let state: State = "OUT";
  let buf = "";
  let attrsStartChar = -1;

  const flush = () => {
    if (buf.length) {
      tokens.push(buf);
      buf = "";
    }
  };

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (state === "OUT") {
      if (ch === "'" || ch === '"') {
        // Entering a quoted token; quote chars are not included in the buffer.
        state = ch === "'" ? "SINGLE" : "DOUBLE";
        continue;
      }

      if (/\s/.test(ch)) {
        flush();
        continue;
      }

      if (ch === "\\") {
        const next = trimmed[++i];
        if (next !== undefined) {
          if (buf.length === 0) {
            buf = "";
          }
          buf += next;
        }
        continue;
      }

      if (ch === "{" && attrsStartChar === -1) {
        // First unquoted `{` marks the start of attrs.
        attrsStartChar = i;
        flush();
        // Do NOT tokenize anything beyond this point; break out.
        break;
      }

      buf += ch;
      continue;
    }

    if (state === "SINGLE") {
      if (ch === "'") {
        state = "OUT";
        continue;
      }
      // Everything is literal inside single quotes
      buf += ch;
      continue;
    }

    // state === "DOUBLE"
    if (ch === '"') {
      state = "OUT";
      continue;
    }
    if (ch === "\\") {
      const next = trimmed[++i];
      if (next !== undefined) buf += next;
      continue;
    }
    buf += ch;
  }

  flush();

  let cli: string;
  let attrsText: string | undefined;

  if (attrsStartChar >= 0) {
    cli = trimmed.slice(0, attrsStartChar).trim();
    attrsText = trimmed.slice(attrsStartChar).trim();
  } else {
    cli = trimmed;
    attrsText = undefined;
  }

  return { cliTokens: tokens, cli, attrsText };
}

/**
 * Parse a `cmd/lang + meta` string into:
 * - a POSIX-style PI structure (`pi`) for the **CLI portion**,
 * - an optional JSON5 `{ ... }` attributes object (`attrs`),
 * - plus higher-level metadata (`cmdLang`, `cli`, `attrsText`).
 *
 * The string is conceptually split into:
 *
 *   [command-like portion] [optional JSON5 attrs block]
 *
 * The command-like portion (before the first unquoted `{`) is tokenized using
 * POSIX-like rules (see `scanInfoString`). Flags and positional tokens are
 * extracted only from this portion.
 *
 * The attrs block is the substring from the first unquoted `{` to the end,
 * passed verbatim to JSON5 for parsing. Everything in that trailing block is
 * treated as pure JSON5, **not** as POSIX CLI.
 *
 * Parsing rules (for the CLI portion):
 * - The **first token** is treated as a `cmd/lang` hint.
 * - By default, this `cmd/lang` is excluded from flag / positional parsing
 *   (`retainCmdLang` is `false`), but is returned separately as `cmdLang`.
 * - When `retainCmdLang` is `true`, the entire token stream (including the
 *   first token) participates in flag and `pos` parsing.
 * - Flags are recognized as:
 *   - `--key=value` or `-k=value`
 *   - `--key value` or `-k value` (two-token form)
 *   - bare tokens (no leading dashes) which become boolean flags `true`.
 *
 * Examples:
 *
 *   "js --tag important { id: 'foo' }"
 *     -> cmdLang === "js"
 *     -> pi.flags.tag === "important"
 *
 *   "ts --name 'hello world' --path \"a b/c\" tag"
 *     -> cmdLang === "ts"
 *     -> pi.flags.name === "hello world"
 *     -> pi.flags.path === "a b/c"
 *     -> pi.flags.tag === true
 */
export function instructionsFromText(
  text: string,
  options?: {
    /**
     * Optional normalization for flag keys (e.g. convert short `"L"` -> `"level"`).
     *
     * Applied to:
     * - `--key=value`
     * - `--key value`
     * - Short form `-k`, `-k=value`, `-k value`
     * - Bare tokens (so `"tag"` can be normalized as needed).
     */
    normalizeFlagKey?: (key: string) => string;
    /**
     * How to handle invalid JSON5 inside the `{ ... }` ATTRS object.
     *
     * - `"ignore"` (default): swallow parse errors and produce an empty object.
     * - `"throw"`: rethrow the parsing error to the caller.
     * - `"store"`: store the raw string under `attrs.__raw` and keep `{}` otherwise.
     */
    onAttrsParseError?: "ignore" | "throw" | "store";
    /**
     * If true, numeric string values like `"9"` are coerced to numbers `9`
     * for flag values parsed from:
     * - `--key value` / `-k value` (two-token form), and
     * - `--key=9` / `-k=9` key-value form.
     *
     * JSON5 parsing of the attrs block already produces numbers where appropriate.
     */
    coerceNumbers?: boolean;
    /**
     * Whether the `cmd/lang` token should participate in flag and `pos` parsing.
     *
     * - `false` (default): the first CLI token is treated purely as a hint and
     *   is **not** parsed as a flag or positional token; it is still returned
     *   as `cmdLang`.
     * - `true`: the first CLI token is treated like any other token and is
     *   included in flag / `pos` parsing.
     */
    retainCmdLang?: boolean;
  },
): InstructionsResult {
  const { cliTokens, cli, attrsText } = scanInfoString(text);

  const cmdLang = cliTokens.length ? cliTokens[0] : undefined;
  const tokens = options?.retainCmdLang ? cliTokens : cliTokens.slice(1);

  // `args` are the CLI tokens only (no tokens from the JSON5 attrs portion).
  const args = [...cliTokens];

  const flags: Record<
    string,
    string | number | boolean | (string | number | boolean)[]
  > = {};
  const pos: string[] = [];

  const normalize = (k: string) =>
    options?.normalizeFlagKey ? options.normalizeFlagKey(k) : k;

  const coerce = (v: string): string | number | boolean => {
    if (options?.coerceNumbers && /^-?\d+(\.\d+)?$/.test(v)) {
      const asNum = Number(v);
      if (!Number.isNaN(asNum)) return asNum;
    }
    return v;
  };

  const pushFlag = (key: string, val: string | number | boolean) => {
    const k = normalize(key.replace(/^(--?)/, ""));
    if (k in flags) {
      const prev = flags[k];
      if (Array.isArray(prev)) prev.push(val);
      else flags[k] = [prev, val];
    } else {
      flags[k] = val;
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];
    const raw = token;

    // normalize leading dashes
    if (token.startsWith("--")) token = token.slice(2);
    else if (token.startsWith("-")) token = token.slice(1);

    // key=value
    const eq = token.indexOf("=");
    if (eq > 0) {
      const k = token.slice(0, eq);
      const vRaw = token.slice(eq + 1);
      const v = vRaw.length ? coerce(vRaw) : true;
      pushFlag(k, v);
      pos.push(normalize(k));
      continue;
    }

    // "--key value" two-token form
    const next = tokens[i + 1];
    if (raw.startsWith("-") && next && !next.startsWith("-")) {
      i++;
      pushFlag(token, coerce(next));
      pos.push(normalize(token));
      continue;
    }

    // bare token (no dashes): treated as a boolean flag
    pushFlag(token, true);
    pos.push(normalize(token));
  }

  const attrs: Record<string, unknown> = {};
  if (attrsText) {
    const raw = attrsText.trim();
    try {
      const parsed = JSON5.parse(raw);
      if (parsed && typeof parsed === "object") {
        Object.assign(attrs, parsed as Record<string, unknown>);
      }
    } catch (err) {
      if (options?.onAttrsParseError === "throw") throw err;
      if (options?.onAttrsParseError === "store") {
        const attrsWithRaw: Record<string, unknown> & { __raw?: string } =
          attrs;
        attrsWithRaw.__raw = raw;
      }
      // otherwise ignore -> attrs stays {}
    }
  }

  return {
    pi: {
      args,
      pos,
      flags,
      count: args.length,
      posCount: pos.length,
    },
    attrs: attrsText ? attrs : undefined,
    cmdLang,
    cli,
    attrsText,
  };
}

export function cacheableInstructionsFromText(
  options: Parameters<typeof instructionsFromText>[1],
) {
  const cache = new Map<string, InstructionsResult>();
  return (text: string) => {
    let ir = cache.get(text);
    if (!ir) {
      ir = instructionsFromText(text, options);
      cache.set(text, ir);
    }
    return ir;
  };
}

/**
 * Options for {@link queryPosixPI}.
 *
 * This is intentionally lightweight; for more complex use cases
 * (custom alias maps, type coercion, etc.) see how higher-level
 * helpers are composed in `posix-pi_test.ts`.
 */
export interface PosixPIQueryOptions<
  FlagsShape extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * Optional normalization for flag names used *at query time*.
   *
   * This should mirror the `normalizeFlagKey` passed to
   * {@link instructionsFromText} so that lookups using long
   * or short names end up on the same canonical key.
   *
   * For example, if parsing used `"L" -> "level"`, you might
   * also apply that here so `getFlag("L", "level")` works.
   */
  normalizeFlagKey?: (key: string) => string;

  /**
   * Optional Zod schema describing the expected shape of `pi.flags`.
   *
   * When provided:
   * - `safeFlags()` uses `schema.safeParse(pi.flags)` and returns the
   *   usual Zod-safe-parse result, typed as `FlagsShape`.
   * - `flags()` calls `safeFlags()` and:
   *    - returns `data` when `success === true`,
   *    - throws a ZodError with extra context when `success === false`.
   *
   * When omitted:
   * - `safeFlags()` returns `{ success: true, data: pi.flags as FlagsShape }`.
   * - `flags()` returns `pi.flags as FlagsShape`.
   */
  zodSchema?: z.ZodType<FlagsShape>;
}

/**
 * Convenience wrapper returned by {@link queryPosixPI}.
 *
 * It provides a small "query API" over the raw `PosixStylePI`
 * so that callers don't have to repeatedly implement the
 * common patterns of:
 *
 * - finding the first / second bare word,
 * - checking whether any of several flag names are present,
 * - retrieving scalar or list-style flag values.
 *
 * For usage patterns and expectations, see the tests in
 * `posix-pi_test.ts` (look for `queryPosixPI` cases).
 */
export interface PosixPIQuery<
  FlagsShape extends Record<string, unknown> = Record<string, unknown>,
> {
  /** The underlying parsed PI (CLI portion only). */
  readonly pi: PosixStylePI;
  /** The JSON5 attrs object that was parsed alongside this PI, if any. */
  readonly attrs?: Record<string, unknown>;
  /**
   * The `cmd/lang` hint, derived from `pi.args[0]` if present.
   *
   * Note: this will match the `cmdLang` returned from
   * {@link instructionsFromText} when both are used together.
   */
  readonly cmdLang?: string;
  /**
   * All "bare words" discovered in the CLI portion, in order.
   *
   * A bare word is:
   * - a token that does not start with `-`, and
   * - is not used as the value for a preceding flag in a
   *   two-token form (`--key value` / `-k value`).
   *
   * The `cmd/lang` token is never included here.
   */
  readonly bareWords: string[];

  /** Return the bare word at a given 0-based index, if present. */
  getBareWord(index: number): string | undefined;

  /** Shorthand for the first bare word (index 0). */
  getFirstBareWord(): string | undefined;

  /** Shorthand for the second bare word (index 1). */
  getSecondBareWord(): string | undefined;

  /**
   * Return the value of the first matching flag among `names`, or `undefined`.
   *
   * Names can be short or long (e.g. `"L"`, `"level"`, `"--level"`); they are
   * normalized by stripping leading dashes and then passing through
   * `options.normalizeFlagKey` when supplied.
   *
   * If the underlying PI stored an array for this flag, the array is returned
   * as-is. If a scalar was stored, the scalar is returned.
   */
  getFlag<T = unknown>(...names: string[]): T | undefined;

  /**
   * Return the value of the first matching string typed flag among `names`, or
   * `undefined`.
   *
   * Names can be short or long (e.g. `"L"`, `"level"`, `"--level"`); they are
   * normalized by stripping leading dashes and then passing through
   * `options.normalizeFlagKey` when supplied.
   *
   * If the underlying PI stored an array for this flag, first element is returned
   * as-is. If a scalar was stored, the scalar is returned.
   */
  getTextFlag<T extends string = string>(...names: string[]): T | undefined;

  /**
   * True if any of the given flag names is present in `pi.flags`.
   *
   * The same normalization rules as {@link getFlag} apply.
   */
  hasFlag(...names: string[]): boolean;

  /**
   * Return all values for the given flag names as a flattened array.
   *
   * - Scalar flag values are pushed as a single element.
   * - Array-valued flags are concatenated.
   * - Flags that are not present are skipped.
   *
   * This is useful when multiple names should be treated as the
   * same logical option (e.g. `-t`, `--tag`, `--tags`).
   */
  getFlagValues<T = unknown>(...names: string[]): T[];

  /**
   * Return all values for the given text flag names as a flattened array.
   *
   * - Scalar flag values are pushed as a single element.
   * - Array-valued flags are concatenated.
   * - Flags that are not present are skipped.
   *
   * This is useful when multiple names should be treated as the
   * same logical option (e.g. `-t`, `--tag`, `--tags`).
   */
  getTextFlagValues<T extends string = string>(...names: string[]): T[];

  /**
   * Convenience helper for boolean-style flags.
   *
   * Returns:
   * - `true` if any named flag exists and is not strictly `false`,
   * - `false` otherwise.
   *
   * This lets callers treat bare flags (`--verbose`) and value flags
   * (`--verbose=true`) uniformly.
   */
  isEnabled(...names: string[]): boolean;

  /**
   * Safe Zod-backed validation result for `pi.flags`.
   *
   * - With schema: mirrors `schema.safeParse(pi.flags)`, but with `data`
   *   typed as `FlagsShape`.
   * - Without schema: returns `{ success: true, data: pi.flags as FlagsShape }`.
   */
  safeFlags(): { success: true; data: FlagsShape } | {
    success: false;
    error: z.ZodError<unknown>;
  };

  /**
   * Strict Zod-backed access to flags.
   *
   * - With schema: returns parsed `FlagsShape` or throws `ZodError`.
   * - Without schema: returns `pi.flags as FlagsShape`.
   */
  flags(): FlagsShape;
}

/**
 * Build a convenience query wrapper for a given {@link PosixStylePI}.
 *
 * This does not modify the PI; it simply layers a small, ergonomic
 * API for common access patterns used when interpreting CLI-style
 * metadata extracted from code fences or similar sources.
 *
 * Typical usage is:
 *
 *   const { pi, attrs } = instructionsFromText(infoString, ...);
 *   const q = queryPosixPI(pi, attrs, { normalizeFlagKey });
 *
 *   const partialName = q.getFirstBareWord();
 *   const level = q.getFlag<number>("L", "level");
 *   const tags  = q.getFlagValues<string>("tag", "tags");
 *
 * For concrete examples and expectations, see `posix-pi_test.ts`.
 */
export function queryPosixPI<
  FlagsShape extends Record<string, unknown> = Record<string, unknown>,
>(
  pi: PosixStylePI,
  attrs?: Record<string, unknown>,
  options?: PosixPIQueryOptions<FlagsShape>,
): PosixPIQuery<FlagsShape> {
  const normalizeKey = (name: string): string => {
    const stripped = name.replace(/^(--?)/, "");
    return options?.normalizeFlagKey
      ? options.normalizeFlagKey(stripped)
      : stripped;
  };

  const bareWords: string[] = (() => {
    const out: string[] = [];
    const { args } = pi;

    if (args.length <= 1) return out;

    for (let i = 1; i < args.length; i++) {
      const token = args[i];
      const prev = args[i - 1];

      const isValueForPrevFlag = prev?.startsWith("-") &&
        !prev.includes("=") &&
        !token.startsWith("-");

      if (isValueForPrevFlag) continue;
      if (token.startsWith("-")) continue;

      out.push(token);
    }

    return out;
  })();

  const lookupFirstValue = (...names: string[]): unknown => {
    for (const name of names) {
      const key = normalizeKey(name);
      if (key in pi.flags) return pi.flags[key];
    }
    return undefined;
  };

  const collectValues = (...names: string[]): unknown[] => {
    const values: unknown[] = [];
    const seenKeys = new Set<string>();

    for (const name of names) {
      const key = normalizeKey(name);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const v = pi.flags[key];
      if (v === undefined) continue;
      if (Array.isArray(v)) values.push(...v);
      else values.push(v);
    }
    return values;
  };

  const cmdLang = pi.args.length ? pi.args[0] : undefined;
  const schema = options?.zodSchema;

  return {
    pi,
    attrs,
    cmdLang,
    bareWords,

    getBareWord(index: number) {
      return index >= 0 && index < bareWords.length
        ? bareWords[index]
        : undefined;
    },

    getFirstBareWord() {
      return bareWords[0];
    },

    getSecondBareWord() {
      return bareWords[1];
    },

    getFlag<T = unknown>(...names: string[]): T | undefined {
      return lookupFirstValue(...names) as T | undefined;
    },

    getTextFlag<T extends string = string>(...names: string[]): T | undefined {
      let value = lookupFirstValue(...names);
      if (Array.isArray(value) && value.length > 0) value = value[0];
      if (typeof value === "string") return value as T;
      return undefined;
    },

    hasFlag(...names: string[]): boolean {
      return lookupFirstValue(...names) !== undefined;
    },

    getFlagValues<T = unknown>(...names: string[]): T[] {
      return collectValues(...names) as T[];
    },

    getTextFlagValues<T extends string = string>(...names: string[]): T[] {
      return collectValues(...names).filter((v) =>
        typeof v === "string"
      ) as T[];
    },

    isEnabled(...names: string[]): boolean {
      const v = lookupFirstValue(...names);
      if (v === undefined) return false;
      if (v === false) return false;
      return true;
    },

    safeFlags() {
      if (!schema) {
        return {
          success: true,
          data: pi.flags as unknown as FlagsShape,
        } as const;
      }

      const res = schema.safeParse(pi.flags);
      if (res.success) {
        return { success: true, data: res.data } as const;
      }
      return { success: false, error: res.error } as const;
    },

    flags() {
      if (!schema) {
        return pi.flags as unknown as FlagsShape;
      }

      const res = schema.safeParse(pi.flags);
      if (res.success) return res.data;

      // Add a bit of context, but keep the original error
      res.error.message =
        `posix-pi flags() validation failed: ${res.error.message}`;
      throw res.error;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Flexible text helpers                                                      */
/* -------------------------------------------------------------------------- */

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
