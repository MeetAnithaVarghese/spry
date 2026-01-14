// lib/spawn/function-shell_test.ts
import { assert, assertEquals, assertMatch } from "@std/assert";
import { defineLanguageInitCatalog, LanguageSpawnShell } from "./code-shell.ts";
import { shell as createShell } from "./shell.ts";
import { httpEngine, httpInit } from "./function-shell.ts";

const td = new TextDecoder();

// Replace your startOneShotHttpServer with this version.
function startOneShotHttpServer(
  handler: (req: Request) => Response | Promise<Response>,
): { baseUrl: string; done: Promise<void> } {
  const ac = new AbortController();

  let handled = false;

  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: ac.signal,
      onListen: () => {
        // silence default "Listening on ..." log
      },
    },
    async (req) => {
      const res = await handler(req);

      if (!handled) {
        handled = true;

        // Let the response flush, then abort. We await server.finished in `done`.
        setTimeout(() => {
          try {
            ac.abort();
          } catch {
            // ignore
          }
        }, 10);
      }

      return res;
    },
  );

  const addr = server.addr as Deno.NetAddr;
  const baseUrl = `http://${addr.hostname}:${addr.port}`;

  // Important: wait for the server to actually stop to avoid leak detection.
  const done = server.finished.then(() => undefined).catch(() => undefined);

  return { baseUrl, done };
}

function bytesResponse(
  body: string,
  init?: { status?: number; headers?: Record<string, string> },
) {
  const bytes = new TextEncoder().encode(body);
  const headers = new Headers(init?.headers);
  headers.set("content-length", String(bytes.length));
  return new Response(bytes, { status: init?.status ?? 200, headers });
}

async function runHttpEngine(input: string) {
  const sh = new LanguageSpawnShell(createShell());
  const catalog = defineLanguageInitCatalog({
    http1: httpInit({}),
  });

  const res = await sh.spawn({
    engine: httpEngine,
    catalog,
    init: { ref: "http1" },
    input: { kind: "text", text: input },
  });

  return res;
}

Deno.test("function-shell: httpEngine GET returns headers + body", async () => {
  const { baseUrl, done } = startOneShotHttpServer((req) => {
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === "/hello") {
      return bytesResponse("OK42\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return bytesResponse("not found\n", { status: 404 });
  });

  const httpDoc = `
GET ${baseUrl}/hello
Accept: text/plain

`;

  const res = await runHttpEngine(httpDoc);
  await done;

  assert(res.success);
  assertEquals(res.code, 0);

  const out = td.decode(res.stdout);
  assertMatch(out, /^HTTP 200\b/);
  assert(out.toLowerCase().includes("content-type: text/plain"));
  assert(out.includes("\n\nOK42\n"));
});

Deno.test("function-shell: httpEngine POST JSON echoes body + checks headers", async () => {
  const { baseUrl, done } = startOneShotHttpServer(async (req) => {
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname === "/echo-json") {
      const ct = req.headers.get("content-type") ?? "";
      // we expect caller to send application/json
      if (!ct.toLowerCase().includes("application/json")) {
        return bytesResponse(`bad content-type: ${ct}\n`, { status: 415 });
      }

      const bodyText = await req.text();
      // echo JSON back as JSON (body text should match)
      return bytesResponse(bodyText, {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return bytesResponse("not found\n", { status: 404 });
  });

  const payload = JSON.stringify({ a: 1, b: "two" });

  const httpDoc = `
POST ${baseUrl}/echo-json
Content-Type: application/json
X-Test: abc

${payload}
`;

  const res = await runHttpEngine(httpDoc);
  await done;

  assert(res.success);
  const out = td.decode(res.stdout);

  assertMatch(out, /^HTTP 200\b/);
  assert(out.toLowerCase().includes("content-type: application/json"));
  // body should be present verbatim (engine prints bodyText)
  assert(out.includes(`\n\n${payload}`));
});

Deno.test("function-shell: httpEngine PUT text body echoes length", async () => {
  const { baseUrl, done } = startOneShotHttpServer(async (req) => {
    const u = new URL(req.url);
    if (req.method === "PUT" && u.pathname === "/echo-len") {
      const body = await req.text();
      return bytesResponse(`len=${body.length}\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return bytesResponse("not found\n", { status: 404 });
  });

  const body = "hello put\nsecond line\n";

  const httpDoc = `
PUT ${baseUrl}/echo-len
Content-Type: text/plain

${body}
`;

  const res = await runHttpEngine(httpDoc);
  await done;

  assert(res.success);
  const out = td.decode(res.stdout);

  // Parser trims trailing newlines from the body.
  const expectedBody = body.replace(/\n+$/, "");
  assert(out.includes(`\n\nlen=${expectedBody.length}\n`));
});

Deno.test("function-shell: httpEngine PATCH + duplicate headers preserved by parser", async () => {
  const { baseUrl, done } = startOneShotHttpServer((req) => {
    const u = new URL(req.url);
    if (req.method === "PATCH" && u.pathname === "/hdrs") {
      const all = req.headers.get("x-dupe") ?? "";
      return bytesResponse(`x-dupe=${all}\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return bytesResponse("not found\n", { status: 404 });
  });

  const httpDoc = `
PATCH ${baseUrl}/hdrs
X-Dupe: a
X-Dupe: b

{"op":"x"}
`;

  const res = await runHttpEngine(httpDoc);
  await done;

  assert(res.success);
  const out = td.decode(res.stdout);

  // Deno merges duplicate headers into a comma-separated string.
  // Normalize spaces to be tolerant but still specific.
  const bodyLine = out.split("\n\n")[1] ?? "";
  const normalized = bodyLine.replace(/\s+/g, " ").trim();
  assert(
    normalized === "x-dupe=a,b" ||
      normalized === "x-dupe=a, b",
  );
});

Deno.test("function-shell: httpEngine DELETE no body", async () => {
  const { baseUrl, done } = startOneShotHttpServer(async (req) => {
    const u = new URL(req.url);
    if (req.method === "DELETE" && u.pathname === "/resource") {
      const body = await req.text();
      // For DELETE, we don’t send a body in our test input, so expect empty.
      return bytesResponse(`bodyEmpty=${body.length === 0}\n`);
    }
    return bytesResponse("not found\n", { status: 404 });
  });

  const httpDoc = `
DELETE ${baseUrl}/resource

`;

  const res = await runHttpEngine(httpDoc);
  await done;

  assert(res.success);
  const out = td.decode(res.stdout);
  assert(out.includes("\n\nbodyEmpty=true\n"));
});

Deno.test("function-shell: httpEngine executes only the first request (multiple requests)", async () => {
  let hits = 0;

  const { baseUrl, done } = startOneShotHttpServer((req) => {
    const u = new URL(req.url);
    if (u.pathname === "/first") {
      hits++;
      return bytesResponse("first\n");
    }
    if (u.pathname === "/second") {
      hits++;
      return bytesResponse("second\n");
    }
    return bytesResponse("not found\n", { status: 404 });
  });

  const httpDoc = `
GET ${baseUrl}/first

###
GET ${baseUrl}/second

`;

  const res = await runHttpEngine(httpDoc);
  await done;

  assert(res.success);
  assertEquals(hits, 1);

  const out = td.decode(res.stdout);
  assert(out.includes("\n\nfirst\n"));
});

Deno.test("function-shell: httpEngine GET ignores body even if provided (GET has no body in fetch init)", async () => {
  const { baseUrl, done } = startOneShotHttpServer(async (req) => {
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === "/get-body") {
      const body = await req.text();
      // Deno fetch runner skips body for GET/HEAD.
      return bytesResponse(`seenLen=${body.length}\n`);
    }
    return bytesResponse("not found\n", { status: 404 });
  });

  const httpDoc = `
GET ${baseUrl}/get-body
Content-Type: text/plain

this-should-not-be-sent
`;

  const res = await runHttpEngine(httpDoc);
  await done;

  assert(res.success);
  const out = td.decode(res.stdout);
  assert(out.includes("\n\nseenLen=0\n"));
});
