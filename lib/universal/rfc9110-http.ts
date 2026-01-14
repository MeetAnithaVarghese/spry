// lib/universal/rfc9110-http.ts
/**
 * RFC 9110-ish HTTP request parser + fetch runners.
 *
 * Input is a single text document in a "standard" HTTP format commonly used by
 * REST Client tooling (for example, VS Code humao.rest-client), supporting
 * multiple `###` sections.
 *
 * Each section may contain one or more requests. Each parsed request includes a
 * `fetch` runner that executes that specific request.
 *
 * Supported shape (per request):
 *
 *   METHOD <url-or-path> [HTTP/1.1]
 *   Header-Name: value
 *   Header-Name2: value
 *
 *   <optional body...>
 *
 * Notes:
 * - Leading comment lines (`# ...` or `// ...`) are ignored (before each request line).
 * - Header order is preserved and duplicate headers are allowed.
 * - Body is verbatim text between the header/body separator blank line and the
 *   next request line (or end of section).
 * - Sections are separated by a line that starts with `###`.
 */
export function parsedHttpRequests(input: string) {
  const raw = normalizeNewlines(input);

  const sections = splitIntoSections(raw).map((s, i) =>
    parseSection(s, i, raw)
  );

  const ast = Object.freeze({
    raw,
    sections: sections.map((s) => s.ast),
  });

  return {
    ast,
    sections,
    requests: sections.flatMap((s) => s.requests),
  } as const;
}

type HttpRequestLine = Readonly<{
  method: string;
  url: string;
  version?: string;
}>;

type HttpHeader = Readonly<{ name: string; value: string }>;

type HttpRequestAst = Readonly<{
  requestLine: HttpRequestLine;
  headers: readonly HttpHeader[];
  headerMap: ReadonlyMap<string, readonly string[]>;
  body?: string;
  raw: string;
}>;

type HttpRequestRunner = Readonly<{
  ast: HttpRequestAst;
  fetch: (opts?: {
    fetch?: typeof fetch;
    baseUrl?: string;
    defaultScheme?: "http" | "https";
    signal?: AbortSignal;
    overrideHeaders?: Record<string, string | undefined>;
  }) => Promise<Response>;
}>;

type HttpSectionAst = Readonly<{
  index: number;
  raw: string;
}>;

type HttpSection = Readonly<{
  index: number;
  ast: HttpSectionAst;
  requests: readonly HttpRequestRunner[];
}>;

function normalizeNewlines(s: string) {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isCommentLine(line: string) {
  const t = line.trimStart();
  return t.startsWith("#") || t.startsWith("//");
}

function isSectionDividerLine(line: string) {
  return line.trimStart().startsWith("###");
}

function splitIntoSections(raw: string) {
  const lines = raw.split("\n");
  const sections: string[] = [];

  let cur: string[] = [];
  for (const line of lines) {
    if (isSectionDividerLine(line)) {
      sections.push(cur.join("\n").trim());
      cur = [];
      continue;
    }
    cur.push(line);
  }
  sections.push(cur.join("\n").trim());

  // Drop empty leading/trailing sections deterministically.
  return sections.filter((s) => s.trim().length > 0);
}

function parseSection(sectionText: string, index: number, _fullRaw: string) {
  const lines = sectionText.split("\n");
  const requests = parseRequestsFromLines(lines).map((r) =>
    Object.freeze({
      ast: r,
      fetch: makeFetchRunner(r),
    })
  );

  const sectionAst = Object.freeze({
    index,
    raw: sectionText,
  });

  return Object.freeze({
    index,
    ast: sectionAst,
    requests,
  }) as HttpSection;
}

function parseRequestsFromLines(lines: string[]) {
  const out: HttpRequestAst[] = [];

  let i = 0;
  while (i < lines.length) {
    // Seek next request line (skip blanks/comments).
    const start = findNextRequestLineIndex(lines, i);
    if (start === -1) break;

    const { requestLine, requestLineIndex } = parseRequestLineAt(lines, start);

    // Parse headers/body after request line until next request line or end.
    const afterReq = requestLineIndex + 1;
    const nextReq = findNextRequestLineIndex(lines, afterReq);

    const sliceEnd = nextReq === -1 ? lines.length : nextReq;
    const block = lines.slice(afterReq, sliceEnd);

    const { headers, headerMap, body } = parseHeadersAndBody(block);

    const rawBlock = [
      formatRequestLine(requestLine),
      ...block,
    ].join("\n").trimEnd();

    out.push(
      Object.freeze({
        requestLine,
        headers,
        headerMap,
        body,
        raw: rawBlock,
      }),
    );

    i = sliceEnd;
  }

  return Object.freeze(out);
}

function findNextRequestLineIndex(lines: string[], from: number) {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const t = line.trim();
    if (!t) continue;
    if (isCommentLine(t)) continue;
    if (looksLikeRequestLine(t)) return i;
  }
  return -1;
}

function looksLikeRequestLine(trimmedLine: string) {
  // METHOD SP URL [SP HTTP/x.y]
  // Accept common HTTP methods; case-insensitive; deterministic check.
  const parts = trimmedLine.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;

  const m = parts[0]!.toUpperCase();
  if (
    m !== "GET" &&
    m !== "POST" &&
    m !== "PUT" &&
    m !== "PATCH" &&
    m !== "DELETE" &&
    m !== "HEAD" &&
    m !== "OPTIONS" &&
    m !== "TRACE" &&
    m !== "CONNECT"
  ) return false;

  // URL token can be absolute or path-ish; leave validation to resolver.
  return true;
}

function parseRequestLineAt(lines: string[], idx: number) {
  const line = (lines[idx] ?? "").trim();
  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      "parsedHttpRequests: invalid request line (expected: METHOD <url> [HTTP/x.y])",
    );
  }

  const method = parts[0]!.toUpperCase();
  const url = parts[1]!;
  const version = parts.length >= 3 ? parts.slice(2).join(" ") : undefined;

  return {
    requestLineIndex: idx,
    requestLine: Object.freeze({ method, url, version }),
  };
}

function parseHeadersAndBody(linesAfterRequestLine: string[]) {
  const headers: Array<{ name: string; value: string }> = [];
  const headerMap = new Map<string, readonly string[]>();

  let i = 0;

  // Headers until first blank line. Comments allowed.
  for (; i < linesAfterRequestLine.length; i++) {
    const line = linesAfterRequestLine[i] ?? "";
    if (line.trim() === "") {
      i++; // consume blank line; body begins after
      break;
    }

    if (isCommentLine(line)) continue;

    const idx = line.indexOf(":");
    if (idx <= 0) {
      throw new Error(
        `parsedHttpRequests: invalid header line '${line}' (expected 'Name: value')`,
      );
    }

    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trimStart();
    headers.push({ name, value });
  }

  for (const h of headers) {
    const k = h.name.toLowerCase();
    const existing = headerMap.get(k);
    headerMap.set(k, existing ? [...existing, h.value] : [h.value]);
  }

  const bodyLines = linesAfterRequestLine.slice(i);

  // Body is verbatim, including blank lines, but we trim only trailing newlines.
  const bodyRaw = bodyLines.join("\n");
  const body = bodyRaw.length ? bodyRaw.replace(/\n+$/, "") : undefined;

  return {
    headers: Object.freeze(headers.map((h) => Object.freeze(h))),
    headerMap: headerMap as ReadonlyMap<string, readonly string[]>,
    body,
  } as const;
}

function formatRequestLine(rl: HttpRequestLine) {
  return rl.version
    ? `${rl.method} ${rl.url} ${rl.version}`
    : `${rl.method} ${rl.url}`;
}

function makeFetchRunner(ast: HttpRequestAst) {
  return async (opts?: {
    fetch?: typeof fetch;
    baseUrl?: string;
    defaultScheme?: "http" | "https";
    signal?: AbortSignal;
    overrideHeaders?: Record<string, string | undefined>;
  }) => {
    const f = opts?.fetch ?? fetch;

    const url = resolveUrl({
      urlOrPath: ast.requestLine.url,
      baseUrl: opts?.baseUrl,
      defaultScheme: opts?.defaultScheme ?? "https",
      headerMap: ast.headerMap,
    });

    const headersInit = new Headers();
    for (const h of ast.headers) headersInit.append(h.name, h.value);

    if (opts?.overrideHeaders) {
      for (const [k, v] of Object.entries(opts.overrideHeaders)) {
        if (v === undefined) headersInit.delete(k);
        else headersInit.set(k, v);
      }
    }

    const method = ast.requestLine.method;
    const hasBody = ast.body !== undefined && ast.body.length > 0;

    const init = {
      method,
      headers: headersInit,
      signal: opts?.signal,
      ...(hasBody && method !== "GET" && method !== "HEAD"
        ? { body: ast.body }
        : {}),
    } as const;

    return await f(url, init);
  };
}

function resolveUrl(init: {
  urlOrPath: string;
  baseUrl?: string;
  defaultScheme: "http" | "https";
  headerMap: ReadonlyMap<string, readonly string[]>;
}) {
  const u = init.urlOrPath.trim();

  if (/^https?:\/\//i.test(u)) return u;

  if (init.baseUrl) {
    const base = init.baseUrl.replace(/\/+$/, "");
    if (u.startsWith("/")) return `${base}${u}`;
    return `${base}/${u}`;
  }

  const host = init.headerMap.get("host")?.[0];
  if (host) {
    const scheme = init.defaultScheme;
    if (u.startsWith("/")) return `${scheme}://${host}${u}`;
    return `${scheme}://${host}/${u}`;
  }

  throw new Error(
    "parsedHttpRequests: cannot resolve URL (provide absolute URL, baseUrl, or Host header)",
  );
}
