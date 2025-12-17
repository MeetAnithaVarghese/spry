// flexible-pattern.ts
import { globToRegExp } from "@std/path";

export type FlexiblePattern =
  | { readonly kind: "all" }
  | { readonly kind: "exact"; readonly s: string }
  | { readonly kind: "re"; readonly re: RegExp; readonly negate: boolean }
  | { readonly kind: "glob"; readonly re: RegExp; readonly negate: boolean };

export interface FlexiblePatternsOptions {
  readonly glob?: Parameters<typeof globToRegExp>[1];
  readonly trim?: boolean;
  readonly allowNegation?: boolean;
  readonly defaultKind?: "exact" | "glob";
  readonly preferExactWhenNoGlobMeta?: boolean;
  readonly normalizeValue?: (s: string) => string;
  readonly allowQuotedExact?: boolean;
}

export interface ListTestOptions {
  /**
   * If true (default), list operations evaluate negated patterns first,
   * then non-negated patterns, preserving relative order within each group.
   *
   * This affects evaluation order (and can matter for short-circuit timing),
   * but not the logical result for pure predicates.
   */
  readonly prioritizedNegations?: boolean;
}

export interface AllowDenySpec<T extends FlexiblePattern | string> {
  readonly allow?: readonly T[];
  readonly deny?: readonly T[];
}

export interface FlexiblePatternsApi {
  parse(raw: string): FlexiblePattern;
  test(pat: FlexiblePattern, value: string): boolean;
  matches(rawPattern: string, value: string): boolean;
  toDebugString(pat: FlexiblePattern): string;

  /**
   * Convenience for checking a value against multiple patterns.
   * Accepts either already-parsed patterns or raw pattern strings.
   */
  testSome(
    patterns: readonly (FlexiblePattern | string)[],
    value: string,
    opts?: ListTestOptions,
  ): boolean;

  testAll(
    patterns: readonly (FlexiblePattern | string)[],
    value: string,
    opts?: ListTestOptions,
  ): boolean;

  testNone(
    patterns: readonly (FlexiblePattern | string)[],
    value: string,
    opts?: ListTestOptions,
  ): boolean;

  /**
   * Returns the subset of patterns (preserving original order) that match `value`.
   * Evaluation can be negation-prioritized, but output order remains input order.
   */
  filterMatching<T extends FlexiblePattern | string>(
    patterns: readonly T[],
    value: string,
    opts?: ListTestOptions,
  ): T[];

  /**
   * True if any pattern in the list is `kind: "all"` (or raw "*").
   */
  hasMatchAll(
    patterns: readonly (FlexiblePattern | string)[],
    opts?: ListTestOptions,
  ): boolean;

  /**
   * Standard allow/deny evaluation:
   * - If any deny matches => false
   * - Else if allow list empty/missing => true
   * - Else if any allow matches => true
   * - Else => false
   */
  testAllowDeny<T extends FlexiblePattern | string>(
    spec: AllowDenySpec<T>,
    value: string,
    opts?: ListTestOptions,
  ): boolean;

  readonly opts:
    & Required<
      Omit<
        FlexiblePatternsOptions,
        "glob" | "normalizeValue"
      >
    >
    & Pick<FlexiblePatternsOptions, "glob" | "normalizeValue">;
}

export function flexiblePatterns(
  options: FlexiblePatternsOptions = {},
): FlexiblePatternsApi {
  const opts: FlexiblePatternsApi["opts"] = {
    glob: options.glob,
    trim: options.trim ?? true,
    allowNegation: options.allowNegation ?? true,
    defaultKind: options.defaultKind ?? "exact",
    preferExactWhenNoGlobMeta: options.preferExactWhenNoGlobMeta ?? true,
    normalizeValue: options.normalizeValue,
    allowQuotedExact: options.allowQuotedExact ?? true,
  };

  const norm = (s: string) => {
    const t = opts.trim ? s.trim() : s;
    return opts.normalizeValue ? opts.normalizeValue(t) : t;
  };

  const unquoteIfQuoted = (s: string): string | undefined => {
    if (!opts.allowQuotedExact) return undefined;
    if (s.length >= 2) {
      const a = s[0];
      const b = s[s.length - 1];
      if ((a === `"` && b === `"`) || (a === `'` && b === `'`)) {
        return s.slice(1, -1);
      }
    }
    return undefined;
  };

  const isRegexToken = (t: string) =>
    t.startsWith("/") && t.endsWith("/") && t.length >= 2;

  const isNegRegexToken = (t: string) =>
    opts.allowNegation && t.startsWith("!/") && t.endsWith("/") &&
    t.length >= 4;

  const hasGlobMeta = (t: string) => /[*?\[\]{}()]/.test(t);

  const parseGlob = (raw: string, negate: boolean): FlexiblePattern => {
    const t = norm(raw);
    const shouldBeExact = opts.preferExactWhenNoGlobMeta && !hasGlobMeta(t);
    if (shouldBeExact) return { kind: "exact", s: norm(t) };
    return { kind: "glob", re: globToRegExp(t, opts.glob), negate };
  };

  const api: FlexiblePatternsApi = {
    opts,

    parse(raw: string): FlexiblePattern {
      const rawTrimmed = opts.trim ? raw.trim() : raw;
      if (!rawTrimmed) return { kind: "exact", s: "" };

      if (rawTrimmed === "*") return { kind: "all" };

      const uq = unquoteIfQuoted(rawTrimmed);
      if (uq !== undefined) return { kind: "exact", s: norm(uq) };

      if (isNegRegexToken(rawTrimmed)) {
        const body = rawTrimmed.slice(2, -1);
        return { kind: "re", re: new RegExp(body), negate: true };
      }

      if (isRegexToken(rawTrimmed)) {
        const body = rawTrimmed.slice(1, -1);
        return { kind: "re", re: new RegExp(body), negate: false };
      }

      // Optional negated glob: !*.sql
      if (opts.allowNegation && rawTrimmed.startsWith("!")) {
        const rest = rawTrimmed.slice(1);
        return parseGlob(rest, true);
      }

      if (opts.defaultKind === "glob") {
        return parseGlob(rawTrimmed, false);
      }

      return { kind: "exact", s: norm(rawTrimmed) };
    },

    test(pat: FlexiblePattern, value: string): boolean {
      const v = norm(value);

      switch (pat.kind) {
        case "all":
          return true;
        case "exact":
          return v === norm(pat.s);
        case "re": {
          const hit = pat.re.test(v);
          return pat.negate ? !hit : hit;
        }
        case "glob": {
          const hit = pat.re.test(v);
          return pat.negate ? !hit : hit;
        }
      }
    },

    matches(rawPattern: string, value: string): boolean {
      return api.test(api.parse(rawPattern), value);
    },

    toDebugString(pat: FlexiblePattern): string {
      switch (pat.kind) {
        case "all":
          return "*";
        case "exact":
          return `exact:${JSON.stringify(pat.s)}`;
        case "re":
          return `${pat.negate ? "not " : ""}re:/${pat.re.source}/`;
        case "glob":
          return `${pat.negate ? "not " : ""}glob:/${pat.re.source}/`;
      }
    },

    testSome(patterns, value, lopts) {
      const it = iterPatterns(patterns, api, lopts);
      for (const p of it) {
        if (api.test(p, value)) return true;
      }
      return false;
    },

    testAll(patterns, value, lopts) {
      const it = iterPatterns(patterns, api, lopts);
      for (const p of it) {
        if (!api.test(p, value)) return false;
      }
      return true;
    },

    testNone(patterns, value, lopts) {
      const it = iterPatterns(patterns, api, lopts);
      for (const p of it) {
        if (api.test(p, value)) return false;
      }
      return true;
    },

    filterMatching(patterns, value, lopts) {
      // Evaluate potentially in prioritized order, but return matches
      // preserving the ORIGINAL input order.
      const matched = new Set<number>();

      let idx = 0;
      const parsed: FlexiblePattern[] = [];
      for (const p of patterns) {
        parsed.push(typeof p === "string" ? api.parse(p) : p);
        idx++;
      }

      for (const { i, pat } of iterPatternsIndexed(parsed, lopts)) {
        if (api.test(pat, value)) matched.add(i);
      }

      const out: Any[] = [];
      for (let i = 0; i < patterns.length; i++) {
        if (matched.has(i)) out.push(patterns[i]);
      }
      return out as typeof patterns[number][];
    },

    hasMatchAll(patterns, lopts) {
      const it = iterPatterns(patterns, api, lopts);
      for (const p of it) {
        if (p.kind === "all") return true;
      }
      return false;
    },

    testAllowDeny(spec, value, lopts) {
      const deny = spec.deny ?? [];
      if (deny.length > 0 && api.testSome(deny, value, lopts)) return false;

      const allow = spec.allow ?? [];
      if (allow.length === 0) return true;

      return api.testSome(allow, value, lopts);
    },
  };

  return api;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers for list evaluation                                       */
/* -------------------------------------------------------------------------- */

// deno-lint-ignore no-explicit-any
type Any = any;

export function isNegatable(
  p: FlexiblePattern,
): p is
  | { readonly kind: "re"; readonly re: RegExp; readonly negate: boolean }
  | {
    readonly kind: "glob";
    readonly re: RegExp;
    readonly negate: boolean;
  } {
  return p.kind === "re" || p.kind === "glob";
}

export function isNegatedRaw(s: string): boolean {
  const t = s.trim();
  // covers !/re/ and !glob (e.g., !*.sql)
  return t.startsWith("!");
}

export function isNegatedPattern(p: FlexiblePattern | string): boolean {
  if (typeof p === "string") return isNegatedRaw(p);
  return isNegatable(p) ? p.negate : false;
}

export function* iterPatterns(
  patterns: readonly (FlexiblePattern | string)[],
  api: FlexiblePatternsApi,
  lopts?: ListTestOptions,
): Generator<FlexiblePattern> {
  const prioritizedNegations = lopts?.prioritizedNegations ?? true;

  if (!prioritizedNegations) {
    for (const p of patterns) yield (typeof p === "string" ? api.parse(p) : p);
    return;
  }

  // Pass 1: negations
  for (const p of patterns) {
    if (!isNegatedPattern(p)) continue;
    yield (typeof p === "string" ? api.parse(p) : p);
  }

  // Pass 2: everything else
  for (const p of patterns) {
    if (isNegatedPattern(p)) continue;
    yield (typeof p === "string" ? api.parse(p) : p);
  }
}

export function* iterPatternsIndexed(
  parsed: readonly FlexiblePattern[],
  lopts?: ListTestOptions,
): Generator<{ i: number; pat: FlexiblePattern }> {
  const prioritizedNegations = lopts?.prioritizedNegations ?? true;

  if (!prioritizedNegations) {
    for (let i = 0; i < parsed.length; i++) yield { i, pat: parsed[i] };
    return;
  }

  // Pass 1: negated patterns only
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (isNegatable(p) && p.negate) yield { i, pat: p };
  }

  // Pass 2: non-negated patterns
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const neg = isNegatable(p) ? p.negate : false;
    if (!neg) yield { i, pat: p };
  }
}
