// lib/universal/rfc9110-http_test.ts
import { assert, assertEquals, assertMatch } from "@std/assert";
import { parsedHttpRequests } from "./rfc9110-http.ts";

function jsonBody(init?: unknown) {
  const ri = init as RequestInit | undefined;
  if (!ri?.body) return undefined;
  return typeof ri.body === "string" ? ri.body : undefined;
}

Deno.test({
  name:
    "rfc9110-http: parses ### sections and builds per-request fetch runners",
  async fn(t) {
    const doc = `
### TLS REST (JSON)
# A typical JSON API call
POST https://api.example.com/v1/patients HTTP/1.1
Accept: application/json
Content-Type: application/json
Authorization: Bearer synthetic-token

{"name":"Asha","age":31}

### GraphQL
POST /graphql HTTP/1.1
Host: graphql.example.org
Content-Type: application/json
Accept: application/json

{"query":"query Patient($id:ID!){ patient(id:$id){ id name } }","variables":{"id":"p_123"}}

# second request in same section (often used for follow-ups)
POST /graphql HTTP/1.1
Host: graphql.example.org
Content-Type: application/json

{"query":"mutation Upsert($name:String!){ upsertPatient(name:$name){ id } }","variables":{"name":"Bilal"}}

### Plain HTTP (no TLS) + baseUrl required
GET /healthz HTTP/1.1
Accept: text/plain
`;

    const parsed = parsedHttpRequests(doc);

    // IMPORTANT: In Deno, don't call t.step() without awaiting it.
    // Otherwise, steps may overlap and you'll see "Started test step while another
    // test step with sanitizers was running".

    await t.step("AST includes sections and requests in stable order", () => {
      assert(parsed.ast.raw.includes("TLS REST"));
      assertEquals(parsed.sections.length, 3);

      assertEquals(parsed.sections[0]!.index, 0);
      assertEquals(parsed.sections[1]!.index, 1);
      assertEquals(parsed.sections[2]!.index, 2);

      assertEquals(parsed.sections[0]!.requests.length, 1);
      assertEquals(parsed.sections[1]!.requests.length, 2);
      assertEquals(parsed.sections[2]!.requests.length, 1);

      assertEquals(parsed.requests.length, 4);

      const r0 = parsed.requests[0]!.ast.requestLine;
      assertEquals(r0.method, "POST");
      assertEquals(r0.url, "https://api.example.com/v1/patients");
      assertMatch(r0.version ?? "", /^HTTP\/1\./);

      const r1 = parsed.requests[1]!.ast.requestLine;
      assertEquals(r1.method, "POST");
      assertEquals(r1.url, "/graphql");
    });

    await t.step(
      "fetch runner executes TLS REST request with method/headers/body",
      async () => {
        const seen: Array<{ url: string; init?: unknown }> = [];

        const fakeFetch: typeof fetch = (url, init) => {
          seen.push({ url: String(url), init });
          return Promise.resolve(new Response("ok", { status: 200 }));
        };

        const r = parsed.requests[0]!;
        const res = await r.fetch({ fetch: fakeFetch });

        assertEquals(res.status, 200);
        assertEquals(seen.length, 1);

        const call = seen[0]!;
        assertEquals(call.url, "https://api.example.com/v1/patients");

        const ri = call.init as RequestInit | undefined;
        assertEquals(ri?.method, "POST");

        const h = new Headers(ri?.headers);
        assertEquals(h.get("accept"), "application/json");
        assertEquals(h.get("content-type"), "application/json");
        assertEquals(h.get("authorization"), "Bearer synthetic-token");

        assertEquals(jsonBody(call.init), `{"name":"Asha","age":31}`);
      },
    );

    await t.step(
      "fetch runner resolves relative URL via Host header (default https)",
      async () => {
        const seen: Array<{ url: string; init?: unknown }> = [];

        const fakeFetch: typeof fetch = (url, init) => {
          seen.push({ url: String(url), init });
          return Promise.resolve(new Response("ok", { status: 200 }));
        };

        const r = parsed.requests[1]!;
        await r.fetch({ fetch: fakeFetch }); // no baseUrl, uses Host header + default https

        assertEquals(seen.length, 1);
        assertEquals(seen[0]!.url, "https://graphql.example.org/graphql");

        const ri = seen[0]!.init as RequestInit | undefined;
        const h = new Headers(ri?.headers);
        assertEquals(h.get("host"), "graphql.example.org");
        assertEquals(h.get("content-type"), "application/json");
        assertEquals(h.get("accept"), "application/json");

        assertMatch(jsonBody(seen[0]!.init) ?? "", /"query":"query Patient/);
      },
    );

    await t.step(
      "fetch runner resolves relative URL via baseUrl (HTTP example)",
      async () => {
        const seen: Array<{ url: string; init?: unknown }> = [];

        const fakeFetch: typeof fetch = (url, init) => {
          seen.push({ url: String(url), init });
          return Promise.resolve(new Response("ok", { status: 200 }));
        };

        const r = parsed.requests[3]!;
        await r.fetch({ fetch: fakeFetch, baseUrl: "http://localhost:8080" });

        assertEquals(seen.length, 1);
        assertEquals(seen[0]!.url, "http://localhost:8080/healthz");

        const ri = seen[0]!.init as RequestInit | undefined;
        assertEquals(ri?.method, "GET");

        const h = new Headers(ri?.headers);
        assertEquals(h.get("accept"), "text/plain");
      },
    );
  },
});

Deno.test({
  name:
    "rfc9110-http: realistic API patterns (RPC, duplicate headers, overrides)",
  async fn(t) {
    const doc = `
### JSON-RPC over HTTP
POST https://rpc.example.net/api HTTP/1.1
Content-Type: application/json
Accept: application/json
X-Trace-Id: trace-1
X-Trace-Id: trace-2

{"jsonrpc":"2.0","id":"req-7","method":"Patient.Get","params":{"id":"p_42"}}

### gRPC-ish (HTTP/2 semantics represented as headers)
POST https://grpc.example.net.PatientService/GetPatient HTTP/1.1
Content-Type: application/grpc
TE: trailers
`;

    const parsed = parsedHttpRequests(doc);

    await t.step(
      "preserves duplicate headers and exposes a normalized headerMap",
      () => {
        assertEquals(parsed.requests.length, 2);

        const r0 = parsed.requests[0]!.ast;
        assertEquals(r0.requestLine.method, "POST");
        assertEquals(r0.headerMap.get("x-trace-id"), ["trace-1", "trace-2"]);

        const headers = r0.headers.filter((h) =>
          h.name.toLowerCase() === "x-trace-id"
        );
        assertEquals(headers.map((h) => h.value), ["trace-1", "trace-2"]);
      },
    );

    await t.step(
      "fetch runner supports overrideHeaders (set and delete)",
      async () => {
        const seen: Array<{ url: string; init?: unknown }> = [];

        const fakeFetch: typeof fetch = (url, init) => {
          seen.push({ url: String(url), init });
          return Promise.resolve(new Response("ok", { status: 200 }));
        };

        const r0 = parsed.requests[0]!;
        await r0.fetch({
          fetch: fakeFetch,
          overrideHeaders: {
            "x-trace-id": "trace-overridden",
            "accept": undefined, // delete
            "x-extra": "added",
          },
        });

        assertEquals(seen.length, 1);

        const ri = seen[0]!.init as RequestInit | undefined;
        const h = new Headers(ri?.headers);
        assertEquals(h.get("x-trace-id"), "trace-overridden");
        assertEquals(h.get("accept"), null);
        assertEquals(h.get("x-extra"), "added");
      },
    );

    await t.step(
      "gRPC-ish example sends POST with no body and preserves headers",
      async () => {
        const seen: Array<{ url: string; init?: unknown }> = [];

        const fakeFetch: typeof fetch = (url, init) => {
          seen.push({ url: String(url), init });
          return Promise.resolve(new Response("ok", { status: 200 }));
        };

        const r1 = parsed.requests[1]!;
        await r1.fetch({ fetch: fakeFetch });

        assertEquals(seen.length, 1);
        assertEquals(
          seen[0]!.url,
          "https://grpc.example.net.PatientService/GetPatient",
        );

        const ri = seen[0]!.init as RequestInit | undefined;
        assertEquals(ri?.method, "POST");

        const h = new Headers(ri?.headers);
        assertEquals(h.get("content-type"), "application/grpc");
        assertEquals(h.get("te"), "trailers");

        // body should be absent (undefined), not an empty string
        assertEquals(jsonBody(seen[0]!.init), undefined);
      },
    );
  },
});

Deno.test({
  name: "rfc9110-http: URL resolution errors are deterministic",
  async fn(t) {
    const doc = `
### Missing host/base
GET /v1/ping HTTP/1.1
Accept: application/json
`;

    const parsed = parsedHttpRequests(doc);

    await t.step("throws when relative URL cannot be resolved", async () => {
      let threw = false;
      try {
        await parsed.requests[0]!.fetch({
          fetch: () => Promise.resolve(new Response("nope")),
        });
      } catch (e) {
        threw = true;
        assertMatch(String(e), /cannot resolve url/i);
      }
      assertEquals(threw, true);
    });

    await t.step(
      "can resolve relative URL if baseUrl is supplied",
      async () => {
        const seen: string[] = [];

        const fakeFetch: typeof fetch = (url) => {
          seen.push(String(url));
          return Promise.resolve(new Response("ok", { status: 200 }));
        };

        const res = await parsed.requests[0]!.fetch({
          fetch: fakeFetch,
          baseUrl: "https://svc.internal",
        });

        assertEquals(res.status, 200);
        assertEquals(seen, ["https://svc.internal/v1/ping"]);
      },
    );
  },
});
