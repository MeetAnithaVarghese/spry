/**
 * CQL-mini — CodeCell filter compiler for Spry notebooks.
 *
 * This module compiles a tiny, CodeCell-specific predicate DSL (CQL-mini) into a
 * type-safe filter function over `CodeCell[]`. It’s intentionally minimal:
 *  - Only a single boolean expression (no SELECT, ORDER, LIMIT).
 *  - Compiles to `cells.filter(c => /* predicate *\/)`.
 *  - Targets the fields that actually exist on CodeCell in notebook.ts.
 *
 * Field aliases (DSL → CodeCell)
 *  - lang      → c.language
 *  - text      → c.source
 *  - path      → c.provenance.path
 *  - filename  → c.provenance.filename || basename(c.provenance.path)
 *  - tags      → c.tags || c.attrs.tags  (array)
 *  - flags     → c.parsedPI.flags        (record)
 *  - pi.kind   → c.parsedPI.kind ?? c.parsedPI.firstToken
 *  - Any other dotted path resolves from c.* with optional indexing (e.g., attrs.env, attrs.arr[0]).
 *
 * Grammar (informal)
 *    expr  := expr "&&" expr | expr "||" expr | "!" expr | "(" expr ")" | term
 *    term  := field ":" string                     // string equality (=== on String(field))
 *           | field "~" string                     // substring on String(field)
 *           | field "~" /regex/flags               // regex test against String(field)
 *           | path  "~" glob("**\/*.sql")           // glob match on String(path)
 *           | tag("x")                             // tags.includes("x")
 *           | flag("capture")                      // boolean/string/string[] “is set”
 *           | attr("env") == "prod"                // String(attrs["env"]) === "prod"
 *           | has(pi.kind)                         // existence check for the *value*
 *           | has(flags.capture, "value")          // string equality or array membership
 *           | len(tags) > 0                        // length of array/string value
 *
 * Operators
 *  - Boolean: &&  ||  !
 *  - Comparisons: ==  !=  <  <=  >  >=
 *  - String equality sugar: ":"  (String(lhs) === rhs)
 *  - Substring: "~" with a string RHS (String(lhs).includes(rhs))
 *  - Regex test: "~" with a regex RHS (/.../flags.test(String(lhs)))
 *
 * Helpers
 *  - glob("pattern") within `path ~ glob("...")`; supports **, *, ?
 *  - tag("t")  → Array.isArray(tags) && tags.includes("t")
 *  - flag("k") → flags[k] is enabled/present (boolean true, non-empty string or string[])
 *  - attr("k") → String(attrs[k])  (or use attr("k","v") for equality)
 *  - has(valueExpr) → valueExpr !== undefined && valueExpr !== null
 *  - has(valueExpr, "needle") → string equality or array membership for strings
 *  - len(valueExpr) → length of array/string, else 0
 *
 * API
 *  - compileCqlMini<T = CodeCell>(query: string): (cells: T[]) => T[]
 */

import * as gmd from "../governedmd.ts";

// Base CodeCell type from notebook; used as the default constraint.
// deno-lint-ignore no-explicit-any
export type CodeCell = gmd.CodeCell<any>;

type AnyRec = Record<string, unknown>;
const asRec = (x: unknown): AnyRec => (x as AnyRec) ?? {};

function escapeReChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Minimal glob translator supporting:
 *  - `**` → `.*`
 *  - `*`  → `[^/]*`
 *  - `?`  → `[^/]`
 * Everything else is regex-escaped verbatim.
 */
function GLOB(pat: string): RegExp {
  let re = "^";
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === "*") {
      if (pat[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += escapeReChar(ch);
  }
  re += "$";
  return new RegExp(re);
}

function toStr(x: unknown): string {
  return String(x ?? "");
}

function basename(p?: unknown): string {
  const s = String(p ?? "");
  if (!s) return "";
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

// ---------- Path + field helpers (generic over T extends CodeCell) ----------

function getPath<T extends CodeCell>(c: T, path: string): unknown {
  // Aliases
  if (path === "lang") return (c as unknown as AnyRec)["language"];
  if (path === "text") return (c as unknown as AnyRec)["source"];
  if (path === "path") {
    return asRec((c as unknown as AnyRec)["provenance"])["path"];
  }
  if (path === "filename") {
    const pv = asRec((c as unknown as AnyRec)["provenance"]);
    return (pv["filename"] as unknown) ?? basename(pv["path"]);
  }
  if (path === "tags") {
    const direct = (c as unknown as AnyRec)["tags"];
    if (Array.isArray(direct)) return direct;
    const fromAttrs = asRec((c as unknown as AnyRec)["attrs"])["tags"];
    return Array.isArray(fromAttrs) ? fromAttrs : undefined;
  }
  if (path === "flags") {
    const pi = asRec((c as unknown as AnyRec)["parsedPI"]);
    return asRec(pi["flags"]);
  }
  if (path.startsWith("flags.")) {
    const key = path.slice("flags.".length);
    const flags = asRec(asRec((c as unknown as AnyRec)["parsedPI"])["flags"]);
    return flags[key];
  }
  if (path.startsWith("pi.")) {
    const rest = path.slice(3);
    const pi = asRec((c as unknown as AnyRec)["parsedPI"]);
    if (rest === "kind") {
      const k = pi["kind"];
      const first = pi["firstToken"];
      return (k ?? first) as unknown;
    }
    return rest ? asRec(pi)[rest] : pi;
  }

  // Generic dotted + indexed path
  let cur: unknown = c;
  const parts = path.split(".").flatMap((p) => {
    const segs: string[] = [];
    let m: RegExpExecArray | null;
    const rx = /([^[\]]+)|\[(\d+)\]/g;
    while ((m = rx.exec(p))) segs.push(m[1] ?? m[2]);
    return segs;
  });

  for (const key of parts) {
    if (cur == null) return undefined;
    if (/^\d+$/.test(key)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(key)];
    } else {
      const rec = asRec(cur);
      cur = rec[key];
    }
  }
  return cur;
}

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function LEN(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return v.length;
  return 0;
}

// ---- Flexible flags helpers ----
function flagValue<T extends CodeCell>(c: T, key: string): unknown {
  const flags = asRec(asRec((c as unknown as AnyRec)["parsedPI"])["flags"]);
  return flags[key];
}

/** Predicate semantics for bare flags: true if boolean true, non-empty string, or non-empty string[] */
function flagPred<T extends CodeCell>(c: T, key: string): boolean {
  const v = flagValue(c, key);
  if (v === true) return true;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return false;
}

/** Legacy sugar: flag("k") -> enabled/present per flagPred */
function flagOn<T extends CodeCell>(c: T, key: string): boolean {
  return flagPred(c, key);
}

/** has(value, needle): for string equality or string[] membership */
function hasMatch(val: unknown, needle: unknown): boolean {
  if (typeof val === "string" && typeof needle === "string") {
    return val === needle;
  }
  if (Array.isArray(val) && typeof needle === "string") {
    return (val as unknown[]).includes(needle);
  }
  return false;
}

// Tag/attr helpers stay the same
function tagHas<T extends CodeCell>(c: T, t: string): boolean {
  const tags = getPath(c, "tags");
  return Array.isArray(tags) ? tags.includes(t) : false;
}

function attrEq<T extends CodeCell>(c: T, k: string, val: unknown): boolean {
  const a = asRec((c as unknown as AnyRec)["attrs"]);
  return String(a?.[k]) === String(val);
}

function attrStr<T extends CodeCell>(c: T, k: string): string {
  const a = asRec((c as unknown as AnyRec)["attrs"]);
  return String(a?.[k]);
}

// ---------- Tokenizer ----------
type Tok =
  | { kind: "id"; v: string }
  | { kind: "num"; v: string }
  | { kind: "str"; v: string }
  | { kind: "re"; source: string; flags: string }
  | { kind: "op"; v: string } // && || ! == != <= >= < > : ~ ( ) ,
  | { kind: "eof" };

const OPS = new Set([
  "&&",
  "||",
  "!",
  "==",
  "!=",
  ">=",
  "<=",
  "<",
  ">",
  ":",
  "~",
  "(",
  ")",
  ",",
]);

// Binary operators that may follow a field reference
const BINOPS = new Set([":", "==", "!=", ">=", "<=", ">", "<", "~"]);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;

  const isWS = (c: string) => /\s/.test(c);
  const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9._]/.test(c);

  while (i < src.length) {
    const ch = src[i];

    if (isWS(ch)) {
      i++;
      continue;
    }

    // String: "..."
    if (ch === '"') {
      i++;
      let s = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          s += src[i];
          i++;
          if (i < src.length) s += src[i++];
        } else s += src[i++];
      }
      if (src[i] !== '"') throw new Error("Unterminated string");
      i++;
      out.push({ kind: "str", v: s });
      continue;
    }

    // Regex: /.../flags
    if (ch === "/") {
      i++;
      let body = "";
      while (i < src.length && src[i] !== "/") {
        if (src[i] === "\\") {
          body += src[i];
          i++;
          if (i < src.length) body += src[i++];
        } else body += src[i++];
      }
      if (src[i] !== "/") throw new Error("Unterminated regex");
      i++;
      let flags = "";
      while (i < src.length && /[a-z]/i.test(src[i])) flags += src[i++];
      out.push({ kind: "re", source: body, flags });
      continue;
    }

    // Number
    if (/[0-9]/.test(ch)) {
      let n = ch;
      i++;
      while (i < src.length && /[0-9.]/.test(src[i])) n += src[i++];
      out.push({ kind: "num", v: n });
      continue;
    }

    // Ident
    if (isIdStart(ch)) {
      let id = ch;
      i++;
      while (i < src.length && isId(src[i])) id += src[i++];
      out.push({ kind: "id", v: id });
      continue;
    }

    // Operators/punct (max munch)
    const two = src.slice(i, i + 2);
    const one = src.slice(i, i + 1);
    if (OPS.has(two)) {
      out.push({ kind: "op", v: two });
      i += 2;
      continue;
    }
    if (OPS.has(one)) {
      out.push({ kind: "op", v: one });
      i += 1;
      continue;
    }

    throw new Error(`Unexpected character: '${ch}'`);
  }

  out.push({ kind: "eof" });
  return out;
}

// ---------- Pratt parser that EMITS JS predicate snippets ----------
class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.i];
  }
  private eat(): Tok {
    return this.toks[this.i++];
  }
  private want(kind: Tok["kind"], v?: string): Tok {
    const t = this.peek();
    if (t.kind !== kind || (v && (t as { v?: string }).v !== v)) {
      throw new Error(`Expected ${kind}${v ? " '" + v + "'" : ""}`);
    }
    return this.eat();
  }

  // precedence: ! > comparisons/substring > && > ||
  private lbp(op?: string): number {
    switch (op) {
      case "||":
        return 1;
      case "&&":
        return 2;
      case "==":
      case "!=":
      case ":":
      case "<":
      case "<=":
      case ">":
      case ">=":
      case "~":
        return 3;
      default:
        return 0;
    }
  }

  parse(): string {
    const expr = this.parseExpr(0);
    this.want("eof");
    return expr;
  }

  private parseExpr(rbp: number): string {
    let left = this.nud();
    while (true) {
      const t = this.peek();
      if (t.kind !== "op") break;
      const lbp = this.lbp(t.v);
      if (lbp <= rbp) break;
      const op = this.eat() as { kind: "op"; v: string };
      left = this.led(op.v, left, lbp);
    }
    return left;
  }

  private nud(): string {
    const t = this.eat();

    // unary NOT
    if (t.kind === "op" && t.v === "!") {
      const r = this.parseExpr(9);
      return `(!(${r}))`;
    }

    // group
    if (t.kind === "op" && t.v === "(") {
      const e = this.parseExpr(0);
      this.want("op", ")");
      return `(${e})`;
    }

    if (t.kind === "id") {
      // boolean/null literals
      if (t.v === "true") return "true";
      if (t.v === "false") return "false";
      if (t.v === "null") return "null";

      // function-like helpers
      if (t.v === "tag") return this.parseCall("tag");
      if (t.v === "flag") return this.parseCall("flag");
      if (t.v === "attr") return this.parseCall("attr");
      if (t.v === "has") return this.parseCall("has");
      if (t.v === "len") return this.parseCall("len");
      if (t.v === "glob") {
        throw new Error('glob(...) only allowed as path~glob("pattern")');
      }

      // bare field path (lang, text, filename, attrs.env, pi.kind, flags.capture, ...)
      const id = t.v;
      const next = this.peek();
      const nextIsOp = next.kind === "op";
      const followedByBinary = nextIsOp && BINOPS.has(next.v);
      const followedByArgBoundary = nextIsOp &&
        (next.v === "," || next.v === ")");

      // Standalone predicate ONLY: `flags.X` → flag semantics
      // Do NOT rewrite when used in comparisons or as a function argument.
      if (
        id.startsWith("flags.") && !followedByBinary && !followedByArgBoundary
      ) {
        const key = id.slice("flags.".length);
        return `(flagPred(c, ${JSON.stringify(key)}))`;
      }

      return this.emitField(id);
    }

    if (t.kind === "str") return JSON.stringify(t.v);
    if (t.kind === "num") return t.v;
    if (t.kind === "re") return `/${t.source}/${t.flags}`;

    throw new Error("Unexpected token in expression");
  }

  private led(op: string, left: string, lbp: number): string {
    if (op === "&&" || op === "||") {
      const right = this.parseExpr(lbp);
      return `(${left} ${op} ${right})`;
    }

    if (
      op === ":" || op === "==" || op === "!=" || op === "<" || op === "<=" ||
      op === ">" || op === ">=" || op === "~"
    ) {
      const right = this.parseExpr(lbp);

      if (op === ":") return `(String(${left}) === ${right})`;

      if (op === "~") {
        // Regex RHS: e.g., text~/CREATE\s+TABLE/i
        if (right.startsWith("/")) return `(${right}.test(toStr(${left})))`;
        // path~glob("...") — RHS token rewritten to "glob:pattern"
        if (/^GET\(/.test(left) && right.startsWith('"glob:')) {
          const pat = JSON.parse(right).slice(5); // strip 'glob:'
          return `(GLOB(${JSON.stringify(pat)}).test(toStr(${left})))`;
        }
        // Default: substring
        return `(toStr(${left}).includes(${right}))`;
      }

      if (op === "==") return `(${left} === ${right})`;
      if (op === "!=") return `(${left} !== ${right})`;
      return `(${left} ${op} ${right})`;
    }

    throw new Error(`Unexpected operator ${op}`);
  }

  private parseCall(name: "tag" | "flag" | "attr" | "has" | "len"): string {
    this.want("op", "(");
    const a1 = this.nud(); // usually GET("...") or a literal
    let a2: string | undefined;

    const maybeComma = this.peek();
    if (maybeComma.kind === "op" && maybeComma.v === ",") {
      this.eat();
      a2 = this.nud();
    }
    this.want("op", ")");

    if (name === "tag") return `(tagHas(c, ${a1}))`;
    if (name === "flag") return `(flagOn(c, ${a1}))`;

    if (name === "has") {
      // has(value) or has(value, "needle")
      if (a2) return `(hasMatch(${a1}, ${a2}))`;
      return `(( ${a1} ) !== undefined && ( ${a1} ) !== null)`;
    }

    if (name === "len") return `(LEN(${a1}))`;

    if (name === "attr") {
      // attr("k") == "v"  (parser will compare the returned string)
      // attr("k","v")     (direct equality check)
      if (a2) return `(attrEq(c, ${a1}, ${a2}))`;
      return `(attrStr(c, ${a1}))`;
    }

    throw new Error("unreachable");
  }

  private emitField(id: string): string {
    if (id === "glob") {
      throw new Error('glob(...) only allowed with path~glob("pattern")');
    }
    return `GET(${JSON.stringify(id)})`;
  }
}

/**
 * Compile a CQL-mini predicate into a reusable `T[]` filter.
 */
export function compileCqlMini<T extends CodeCell = CodeCell>(
  query: string,
): (cells: T[]) => T[] {
  const toks = tokenize(
    // Allow the sugar path~glob("..."): rewrite the RHS token to distinguish
    query.replace(
      /(~)\s*glob\(\s*"([^"]+)"\s*\)/g,
      (_m, _tilde, pat) => `~ "glob:${pat}"`,
    ),
  );
  const parser = new Parser(toks);
  const jsExpr = parser.parse();

  type PredFn = (
    c: T,
    GET: (field: string) => unknown,
    toStrFn: (x: unknown) => string,
    GLOBfn: (p: string) => RegExp,
    basenameFn: (p?: unknown) => string,
    getPathFn: (c: T, path: string) => unknown,
    hasValueFn: (v: unknown) => boolean,
    LENfn: (v: unknown) => number,
    tagHasFn: (c: T, t: string) => boolean,
    flagOnFn: (c: T, f: string) => boolean,
    attrEqFn: (c: T, k: string, v: unknown) => boolean,
    attrStrFn: (c: T, k: string) => string,
    flagPredFn: (c: T, k: string) => boolean,
    hasMatchFn: (val: unknown, needle: unknown) => boolean,
  ) => boolean;

  const pred = new Function(
    "c",
    "GET",
    "toStr",
    "GLOB",
    "basename",
    "getPath",
    "hasValue",
    "LEN",
    "tagHas",
    "flagOn",
    "attrEq",
    "attrStr",
    "flagPred",
    "hasMatch",
    `return (${jsExpr});`,
  ) as PredFn;

  return (cells: T[]) =>
    cells.filter((c) =>
      pred(
        c,
        (field: string) => getPath(c, field),
        toStr,
        GLOB,
        basename,
        getPath,
        hasValue,
        LEN,
        tagHas,
        flagOn,
        attrEq,
        attrStr,
        flagPred,
        hasMatch,
      )
    );
}
