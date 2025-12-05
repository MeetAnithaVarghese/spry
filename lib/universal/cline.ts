/**
 * @file cline.ts
 *
 * Lightweight "CLI-ish" parsing helpers.
 *
 * The goal here is:
 *   - Take a freeform string that *looks* like a command line,
 *     or an argv-style string[].
 *   - Tokenize it in a way normal humans expect (quotes, escapes).
 *   - Extract flags and positional args without bringing in a heavy CLI parser.
 *
 * Why "CLI-ish" instead of "true shell parsing"?
 *   - We don't depend on any OS shell rules.
 *   - We don't expand env vars, globs, etc.
 *   - We just give you predictable tokens and flags so you can build
 *     little REPLs, chat commands, task runners, etc.
 *
 * The three main exports are:
 *
 *   1. tokenizeCline(text)
 *      Turn one "command line"-like string into tokens.
 *
 *   2. parseClineFlags(argvOrText, base?)
 *      Parse tokens into { bareTokens, flags }.
 *      You can pass defaults/expected keys in `base` for better typing.
 *
 *   3. hasFlagOfType(flags, key, type) or hasEitherFlagOfType
 *      Runtime type guard for checking / narrowing flag values.
 *
 * The helpers here intentionally avoid any filesystem / Deno APIs.
 * That makes them easy to test and safe to run in environments where
 * you just want to *interpret* a command, not execute it.
 */

/**
 * Values that individual flags can resolve to.
 *
 *   --debug                → { debug: true }
 *   --out dist             → { out: "dist" }
 *   --tag a --tag b        → { tag: ["a", "b"] }
 *
 * We never coerce to number, bigint, etc. That's the caller's job.
 * That sounds annoying, but it prevents bad auto-coercions like
 * `--id 000123` turning into `123` unexpectedly.
 */
export type ClineFlagValue =
  | string
  | boolean
  | string[];

/**
 * Generic shape of the parsed `flags` object.
 *
 * Keys are flag names without the leading `-` or `--`.
 * Values are strings / booleans / string arrays.
 */
export type ClineFlagRecord = Record<string, ClineFlagValue>;

/**
 * Result of `parseClineFlags()`.
 *
 * `B` is the optional "base flags" object type you pass in.
 *
 * Implementation detail:
 * We return `Readonly<ClineFlagRecord> & B` for `flags`.
 * - `Readonly<ClineFlagRecord>` means we promise not to mutate the public
 *   result, even though we do mutate internally during parsing.
 * - `& B` lets you inject known/defaulted keys and keep their types.
 *
 * Example:
 *
 *   const r = parseClineFlags(
 *     `deploy --env prod --debug`,
 *     { debug: false as boolean, env: "" as string },
 *   );
 *
 *   // r.flags.debug is known to exist (boolean)
 *   // r.flags.env   is known to exist (string)
 *   // r.flags.madeUpThing could ALSO appear because user typed it.
 */
export interface ClineParseResult<
  B extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * Positional tokens that did not start with "-" and were not consumed
   * as values for a flag.
   *
   * Example:
   *   run build "src/index.ts" --out dist
   *   bareTokens = ["run", "build", "src/index.ts"]
   */
  bareTokens: string[];

  /**
   * Parsed flags.
   *
   * All `--flag` / `-f` style inputs land here.
   *
   * Values are:
   *   - boolean (for bare flags like `--debug`),
   *   - string  (for single values),
   *   - string[] (for repeated flags: `--tag a --tag b`).
   *
   * Plus (optionally) whatever you put in `base`, so that consumers
   * can rely on keys that must exist even if the user didn't provide them.
   *
   * NOTE: This is a readonly view in the result, on purpose. We don't want
   * downstream code to accidentally mutate it and then wonder why logs,
   * audit trails, etc. are inconsistent.
   */
  flags: Readonly<ClineFlagRecord> & B;
}

/**
 * Minimal POSIX-like tokenizer for CLI-ish text.
 *
 * Converts a single text line into shell-style tokens with very small,
 * predictable rules:
 *
 * - Splits on whitespace.
 *
 * - Single quotes: `'like this'`
 *     Everything is literal until the next `'`.
 *     Backslashes are NOT special here.
 *
 * - Double quotes: `"like this"`
 *     Everything is literal until the next `"`,
 *     EXCEPT that `\"` → `"` and `\\` → `\`.
 *     More generally, any `\X` inside double quotes just becomes `X`.
 *
 * - Outside quotes:
 *     A backslash escapes the next char:
 *       `\x` becomes `x`, including for spaces, quotes, etc.
 *     A trailing `\` at end of string is kept literally as `\`.
 *
 * Edge case / unobvious note:
 * - We intentionally do not support nested quotes, `$VAR`, command
 *   substitution, globbing, etc. The goal is "good enough for
 *   human-entered lines in a chat-style box," not replicating Bash.
 *
 * @param s A single CLI-ish string, e.g.:
 *          build "src/app main.ts" --tag=alpha --debug
 *
 * @returns An argv-like list of tokens, e.g.:
 *          ["build", "src/app main.ts", "--tag=alpha", "--debug"]
 */
export function tokenizeCline(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let q: '"' | "'" | null = null;

  const isSpace = (c: string) => /\s/.test(c);

  while (i < s.length) {
    const ch = s[i];

    if (q) {
      // We're *inside* a quote block.
      // Single-quoted vs double-quoted slightly differ.

      if (q === '"' && ch === "\\") {
        // Inside double quotes we allow \" and \\ (and really \X -> X).
        if (i + 1 < s.length) {
          cur += s[i + 1];
          i += 2;
          continue;
        }
      }

      if (ch === q) {
        // closing quote
        q = null;
        i++;
        continue;
      }

      // otherwise literal
      cur += ch;
      i++;
      continue;
    }

    // We're OUTSIDE quotes.

    if (isSpace(ch)) {
      // Whitespace: finalize the current buffer if non-empty.
      if (cur) {
        out.push(cur);
        cur = "";
      }
      // Skip *all* consecutive spaces so "a   b" => ["a","b"].
      i++;
      while (i < s.length && isSpace(s[i])) i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      // Start of a quoted block.
      q = ch;
      i++;
      continue;
    }

    if (ch === "\\") {
      // Backslash escape outside quotes:
      // "\x" => "x", even if x is space, quote, etc.
      if (i + 1 < s.length) {
        cur += s[i + 1];
        i += 2;
        continue;
      }
      // If it's a dangling "\" at end of input, keep it literal.
      cur += ch;
      i++;
      continue;
    }

    // Normal bare char
    cur += ch;
    i++;
  }

  if (cur) out.push(cur);
  return out;
}

/**
 * Runtime type guard to check that a given property in a `flags` object
 * exists and matches the expected runtime `typeof`.
 *
 * This exists because `parseClineFlags().flags` is intentionally untyped
 * user input, and you'll often want to do safe narrowing before using it.
 *
 * Caveat:
 * - Because `parseClineFlags` only produces `string | boolean | string[]`,
 *   this guard is mostly useful if you're *post-processing* (like converting
 *   `"8080"` into a `number` and storing it back into your own struct).
 *
 * @template T - The full flags object type.
 * @template K - A key within `T` whose value you want to check.
 * @template Expected - A `typeof` string literal you expect:
 *                      "string" | "number" | "boolean" | "object"
 *                      | "function" | "undefined".
 *
 * @param flags The object to inspect (usually `result.flags`).
 * @param key   The property name in `flags` to check.
 * @param expectedType The runtime `typeof` string you expect.
 *
 * @returns `true` if:
 *          - `key` exists in `flags`, AND
 *          - `typeof flags[key] === expectedType`.
 *
 * @example
 * ```ts
 * const r = parseClineFlags('--port=8080 --debug');
 *
 * if (hasFlagOfType(r.flags, 'debug', 'boolean')) {
 *   // narrowed: r.flags.debug is boolean here
 *   console.log('debug?', r.flags.debug);
 * }
 *
 * // Here we manually coerce port and re-check:
 * if (hasFlagOfType(r.flags, 'port', 'string')) {
 *   const portNum = Number(r.flags.port);
 *   if (!Number.isNaN(portNum)) {
 *     // we could stash portNum in our own typed config
 *   }
 * }
 * ```
 */
export function hasFlagOfType<
  T extends Record<string, unknown>,
  K extends keyof T,
  Expected extends
    | "string"
    | "number"
    | "boolean"
    | "object"
    | "function"
    | "undefined",
>(
  flags: T,
  key: K,
  expectedType?: Expected,
): flags is
  & T
  & {
    [P in K]: Expected extends "string" ? string
      : Expected extends "number" ? number
      : Expected extends "boolean" ? boolean
      : Expected extends "object" ? object
      // deno-lint-ignore ban-types
      : Expected extends "function" ? Function
      : Expected extends "undefined" ? undefined
      : never;
  } {
  return expectedType
    ? (key in flags && typeof flags[key] === expectedType)
    : key in flags;
}

/**
 * Runtime type guard that checks whether EITHER of two possible flag keys
 * exists on `flags` and has the expected runtime JS `typeof`.
 *
 * This is useful for supporting paired long/short CLI flags like:
 *   --interpolate  (keyA = "interpolate")
 *   -I             (keyB = "I")
 *
 * If either matches, we return true AND narrow both keys on `flags`
 * to the requested type (e.g. boolean). This lets you safely use either
 * property after the check without a bunch of extra branching.
 *
 * @template T - The full flags object type.
 * @template K1 - First key we're willing to accept on T.
 * @template K2 - Second key we're willing to accept on T.
 * @template Expected - The runtime JS primitive type we expect (`typeof` result).
 *
 * @param flags - The object containing parsed flags.
 * @param keyA - First candidate key, usually the long form.
 * @param keyB - Second candidate key, usually the short alias.
 * @param expectedType - Expected JS runtime type (e.g. "boolean", "string").
 *
 * @returns `true` if either `flags[keyA]` or `flags[keyB]` exists AND
 *          has `typeof === expectedType`. Also acts as a type guard that
 *          narrows BOTH `keyA` and `keyB` on `flags` to that type.
 *
 * @example
 * ```ts
 * const flags = { interpolate: true, I: true, env: "prod" };
 *
 * if (hasEitherFlagOfType(flags, "interpolate", "I", "boolean")) {
 *   // inside here:
 *   //   flags.interpolate is boolean
 *   //   flags.I           is boolean
 *   if (flags.interpolate || flags.I) {
 *     // safe
 *   }
 * }
 * ```
 */
export function hasEitherFlagOfType<
  T extends Record<string, unknown>,
  K1 extends keyof T & string,
  K2 extends keyof T & string,
  Expected extends
    | "string"
    | "number"
    | "boolean"
    | "object"
    | "function"
    | "undefined",
>(
  flags: T,
  keyA: K1,
  keyB: K2,
  expectedType?: Expected,
): flags is
  & T
  & {
    [P in K1 | K2]: Expected extends "string" ? string
      : Expected extends "number" ? number
      : Expected extends "boolean" ? boolean
      : Expected extends "object" ? object
      // deno-lint-ignore ban-types
      : Expected extends "function" ? Function
      : Expected extends "undefined" ? undefined
      : never;
  } {
  const vA = Object.prototype.hasOwnProperty.call(flags, keyA)
    ? flags[keyA]
    : undefined;
  const vB = Object.prototype.hasOwnProperty.call(flags, keyB)
    ? flags[keyB]
    : undefined;

  if (expectedType) {
    const matchA = vA !== undefined && typeof vA === expectedType;
    const matchB = vB !== undefined && typeof vB === expectedType;
    return matchA || matchB;
  }

  return vA !== undefined || vB !== undefined;
}

/**
 * Parse CLI-ish args/tokens into `{ bareTokens, flags }`.
 *
 * Input can be either:
 *   - `string[]`  → treated as pre-tokenized argv
 *   - `string`    → a single CLI-ish line, which we will tokenize
 *                   using `tokenizeCline()`
 *
 * Supported flag forms:
 *   --key=value        => flags.key = "value"
 *   --key value        => flags.key = "value"
 *   --key              => flags.key = true
 *   -k=value           => flags.k   = "value"
 *   -k value           => flags.k   = "value"
 *   -k                 => flags.k   = true
 *
 * Repeated flags turn into arrays of strings:
 *   --tag a --tag b    => flags.tag = ["a", "b"]
 *
 * Bare/positional tokens:
 *   Anything not starting with "-" (and not already consumed as the value
 *   of a previous flag) is appended to `bareTokens` in order.
 *
 * Defaults / type shaping via `base`:
 *
 *   You may pass an optional `base` object. That object is shallow-cloned
 *   into the new `flags` map before we parse argv. This does two things:
 *
 *   1. At runtime: it gives you default values (or guaranteed keys).
 *   2. At compile time: it informs the return type so callers can rely
 *      on those keys existing and having at least that type.
 *
 *   First occurrence in argv WINS over whatever was in `base`. If the same
 *   flag appears again, we promote it to `string[]`.
 *
 * Unobvious but important:
 * - We do not guess types. "8080" stays "8080".
 * - We do not merge booleans beyond first appearance. If the user types
 *   `--debug` twice with `--debug=false` etc we don't try to interpret that.
 *   The second appearance just creates/extends an array of strings.
 *   This is intentional to avoid false assumptions about semantics.
 *
 * @example Basic usage
 * ```ts
 * const r = parseClineFlags(
 *   `build "src/main.ts" --out=dist --tag a --tag "b c" -v`,
 * );
 * // r.bareTokens: ["build", "src/main.ts"]
 * // r.flags: {
 * //   out: "dist",
 * //   tag: ["a", "b c"],
 * //   v: true
 * // }
 * ```
 *
 * @example With defaults / typing
 * ```ts
 * const r = parseClineFlags(
 *   ["deploy", "--env", "prod", "--debug"],
 *   { debug: false as boolean, env: "" as string },
 * );
 *
 * // r.flags.debug is statically known to be boolean
 * // r.flags.env   is statically known to be string
 * // r.bareTokens  is ["deploy"]
 * ```
 *
 * @template B - Optional "base flags" object type.
 *
 * @param argv Either an argv-like array or a CLI-ish string.
 * @param base Optional defaults / expected flags.
 *
 * @returns { bareTokens, flags }
 */
export function parseClineFlags<
  B extends Record<string, unknown> = Record<string, unknown>,
>(
  argv: readonly string[] | string,
  base?: B,
): ClineParseResult<B> {
  /**
   * We normalize `argv` into a readonly string[] called `tokens`.
   *
   * Subtle detail:
   *   We *could* write a helper with overloads to do this. However, Deno's
   *   LSP sometimes chokes on local overloads + union args and shows
   *   "No overload matches this call" even though the code is correct.
   *
   *   The tiny `as string` cast below keeps the code obvious and makes
   *   TypeScript happy without fighting the LSP.
   */
  const tokens: readonly string[] = Array.isArray(argv)
    ? argv
    : tokenizeCline(argv as string);

  // We'll accumulate flags here. It's mutable internally but we'll cast
  // it to a readonly intersection type on return.
  //
  // We start with a shallow clone of `base` (if provided) so that:
  //   1. base keys exist in the final object,
  //   2. and base types get carried through to the caller.
  const flagsOut: ClineFlagRecord = base ? { ...base } as ClineFlagRecord : {};

  // We track which flags we've already seen from *argv*, not counting base.
  // This matters for deciding when to promote a single value to an array.
  const seenFromArg = new Set<string>();

  // Positional (non-dash-prefixed) tokens end up here.
  const bareTokens: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // If it doesn't start with "-" it's a positional arg,
    // unless it's already "consumed" as the value for a prior flag.
    if (!token.startsWith("-")) {
      bareTokens.push(token);
      continue;
    }

    // token starts with "-" or "--"
    const isLong = token.startsWith("--");
    const prefixLen = isLong ? 2 : 1;

    // Pull out the "key" and any "=value" suffix.
    const eqIdx = token.indexOf("=");
    const key = eqIdx === -1
      ? token.slice(prefixLen)
      : token.slice(prefixLen, eqIdx);

    // Ignore things like just `-` or `--` with no key.
    if (!key) continue;

    /**
     * Decide the value for this flag.
     *
     * Cases:
     *   --k=v   / -k=v     => value after '='
     *   --k v   / -k v     => next token (if next token is not another '-...')
     *   --k     / -k       => boolean true
     */
    let rawVal: string | boolean;
    if (eqIdx !== -1) {
      // --key=value / -k=value
      rawVal = token.slice(eqIdx + 1);
    } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
      // --key value / -k value (consume next token so it doesn't appear as bare)
      rawVal = tokens[++i];
    } else {
      // bare flag like --debug or -v
      rawVal = true;
    }

    const existing = flagsOut[key];

    if (Array.isArray(existing)) {
      // We've already got an array for this key → append stringified val.
      flagsOut[key] = [...existing, String(rawVal)];
    } else if (seenFromArg.has(key)) {
      // We've seen this key before (from argv, not just base),
      // but existing wasn't an array yet. Promote it.
      if (typeof existing === "string") {
        flagsOut[key] = [existing, String(rawVal)];
      } else if (existing === true) {
        // previous value was boolean true, now we also saw another "value"
        // The choice to stringify true as "true" is deliberate:
        // we do NOT silently turn booleans into strings except in this
        // "I've been repeated" corner case.
        flagsOut[key] = ["true", String(rawVal)];
      } else {
        // didn't find a prior string/bool, just start fresh array
        flagsOut[key] = [String(rawVal)];
      }
    } else {
      // First time we've seen this key in argv:
      // just store the rawVal (string or true).
      flagsOut[key] = rawVal;
    }

    seenFromArg.add(key);
  }

  return {
    bareTokens,
    flags: flagsOut as Readonly<ClineFlagRecord> & B,
  };
}

/**
 * amendClineFlags()
 *
 * Takes an existing parseClineFlags() result and an additional argv
 * (string or string[]) and returns a new parse-style result where the
 * new argv "amends" the flags.
 *
 * Rules:
 * - Existing bareTokens are preserved (we're only amending flags, not the
 *   original positional intent).
 * - New flags from `argv` are merged in.
 *   - If the flag didn't exist before, we add it.
 *   - If it existed and either side is an array, we concatenate arrays
 *     (promoting scalars to arrays).
 *   - Otherwise, the new value overrides the old value.
 * - Booleans, strings, and string[] are handled.
 *
 * This does NOT mutate the original objects.
 */
export function amendClineFlags(
  existing: ReturnType<typeof parseClineFlags>,
  argv: readonly string[] | string,
): ReturnType<typeof parseClineFlags> {
  // Parse just the amendment argv on its own
  const patch = parseClineFlags(argv);

  // Start merged flags as a shallow clone of existing.flags so we don't mutate
  const merged: Record<string, ClineFlagValue> = {
    ...existing.flags,
  };

  for (const [key, incomingVal] of Object.entries(patch.flags)) {
    const currentVal = merged[key];

    // If the key didn't exist before, just take the incoming value
    if (currentVal === undefined) {
      merged[key] = incomingVal as ClineFlagValue;
      continue;
    }

    // If either side is already an array, concat (promoting scalars to arrays)
    if (Array.isArray(currentVal) || Array.isArray(incomingVal)) {
      const curArr = Array.isArray(currentVal)
        ? currentVal
        : [currentVal as Exclude<typeof currentVal, string[]>];

      const incArr = Array.isArray(incomingVal)
        ? incomingVal
        : [incomingVal as Exclude<typeof incomingVal, string[]>];

      merged[key] = [...curArr, ...incArr] as ClineFlagValue;
      continue;
    }

    // Otherwise both sides are scalars (string | boolean).
    // Latest (incoming) wins.
    merged[key] = incomingVal as ClineFlagValue;
  }

  return {
    bareTokens: [...existing.bareTokens],
    flags: merged as Readonly<ClineFlagRecord>,
  };
}

/**
 * clineFlagsAsCLI()
 *
 * Produce a deterministic CLI-ish string from a parseClineFlags() result.
 *
 * The output is intended so that:
 *
 *   parseClineFlags(clineFlagsAsCLI(r))
 *
 * recreates the *same* final shape of `r` (same bareTokens, same flags),
 * with the following caveat:
 *
 * - `false` booleans cannot be faithfully represented as booleans purely
 *   from CLI text, because parseClineFlags can only create `true` booleans
 *   from argv. If we encounter `false`, we emit `--flag false`, which will
 *   come back as a string "false". This is the best possible round-trip
 *   without carrying a `base`.
 *
 * Quoting rules:
 * - Bare tokens are emitted first, in order.
 * - Then flags are emitted. Each key becomes `--key`.
 * - String values are emitted as `--key value`.
 * - Array-of-string values become repeated `--key value1 --key value2 ...`.
 * - Values that contain whitespace, quotes, or backslashes are wrapped in
 *   double quotes with `\` and `"` escaped so that tokenizeCline() will
 *   hand parseClineFlags() the same string value.
 */
export function clineFlagsAsCLI(
  parsed: ReturnType<typeof parseClineFlags>,
): string {
  function quoteToken(tok: string): string {
    // Always use a conservative double-quote strategy if it's "weird".
    // Weird = empty OR contains whitespace OR contains quote OR contains backslash.
    if (
      tok === "" ||
      /[\s"']/.test(tok) ||
      tok.includes("\\")
    ) {
      const escaped = tok
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
    // Safe as-is
    return tok;
  }

  const parts: string[] = [];

  // 1. bare tokens first, in order as provided originally
  for (const bt of parsed.bareTokens) {
    parts.push(quoteToken(bt));
  }

  // 2. flags
  for (const [key, val] of Object.entries(parsed.flags)) {
    if (Array.isArray(val)) {
      // repeated --key value
      for (const v of val) {
        parts.push(`--${key}`);
        parts.push(quoteToken(v));
      }
      continue;
    }

    if (typeof val === "boolean") {
      if (val) {
        // true boolean => bare flag
        parts.push(`--${key}`);
      } else {
        // cannot really round-trip `false` boolean as boolean
        // emit "--key false" which comes back as string "false"
        parts.push(`--${key}`);
        parts.push("false");
      }
      continue;
    }

    // string
    parts.push(`--${key}`);
    parts.push(quoteToken(val));
  }

  return parts.join(" ");
}
