#!/usr/bin/env -S deno run -A --node-modules-dir=auto
// service.ts
//
// Deno entrypoint for the Spry Graph Viewer.
// - Reads Markdown fixture(s)
// - Runs the Ontology Graphs and Edges rule pipeline
// - Builds a GraphViewerModel (graph-centric JSON)
// - Injects that JSON into index.html and serves it via Deno.serve

import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/completions";
import { HelpCommand } from "@cliffy/help";
import { fromFileUrl, relative } from "@std/path";
import { computeSemVerSync } from "../../../universal/version.ts";
import { buildGraphViewerModelFromFiles } from "./model.ts";

/**
 * We use an "injection" model so that saving the file can allow the HTML to
 * work in static mode.
 * @returns
 */
async function ssrIndexHtml(mdSources: string[]) {
  const htmlTemplate = await Deno.readTextFile(
    fromFileUrl(new URL("./index.html", import.meta.url)),
  );

  const model = await buildGraphViewerModelFromFiles(mdSources);

  const json = JSON.stringify(model);

  // Replace the placeholder script tag with inline JSON
  const injectedHtml = htmlTemplate.replace(
    /<script type="application\/json" id="web-ui\.model\.json"><\/script>/,
    `<script type="application/json" id="web-ui.model.json">${json}</script>`,
  );

  return injectedHtml;
}

/* --------------------------------------------------------------------------- */
/* Server + helpers                                                            */
/* --------------------------------------------------------------------------- */

export async function serve(args: {
  host?: string;
  port?: number;
  launchBrowser?: boolean;
  mdSources: string[];
  watchCandidates?: string[];
  renderOnce?: () => Promise<boolean>;
}) {
  const {
    host = "127.0.0.1",
    port = 9876,
    launchBrowser = false,
    mdSources,
    watchCandidates,
    renderOnce,
  } = args;

  if (mdSources.length == 0) {
    mdSources.push(fromFileUrl(
      new URL("../../fixture/test-fixture-01.md", import.meta.url),
    ));
  }
  const watchTargets = (!watchCandidates || watchCandidates.length == 0)
    ? [...mdSources]
    : watchCandidates;

  watchTargets.push(
    ...["index.html", "index.css", "index.js"].map((f) =>
      fromFileUrl(new URL(`./${f}`, import.meta.url))
    ),
  );

  // Live-reload clients via Server-Sent Events
  const clients = new Set<(msg: string) => void>();

  function injectReloadSnippet(srcHtml: string): string {
    const snippet = `
<script>
  (() => {
    try {
      const es = new EventSource("/events");
      es.onmessage = (ev) => {
        if (ev.data === "reload") {
          location.reload();
        }
      };
      es.onerror = (err) => {
        console.warn("SSE error, will auto-reconnect", err);
        // Do nothing else: EventSource will retry
      };
    } catch (e) {
      console.error("Live reload error", e);
    }
  })();
</script>`;
    if (srcHtml.includes("</body>")) {
      return srcHtml.replace("</body>", snippet + "</body>");
    }
    return srcHtml + snippet;
  }

  function broadcastReload() {
    for (const send of clients) {
      try {
        send("reload");
      } catch {
        // ignore dead streams
      }
    }
  }

  const serverUrl = `http://${host}:${port}`;

  Deno.serve({ hostname: host, port }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/events") {
      // handle page auto-reloads
      const stream = new ReadableStream({
        start(controller) {
          const send = (msg: string) => {
            controller.enqueue(`data: ${msg}\n\n`);
          };
          clients.add(send);
          send("connected");
        },
        cancel() {
          clients.clear();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "access-control-allow-origin": "*",
        },
      });
    }

    // Send heartbeat messages to keep the SSE connection alive.
    setInterval(() => {
      for (const send of clients) {
        try {
          send(": ping");
        } catch {
          // ignore
        }
      }
    }, 15000); // every 15s

    const indexHTML = injectReloadSnippet(await ssrIndexHtml(mdSources));

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/index.css" || url.pathname === "/index.js") {
      const path = fromFileUrl(
        new URL("." + url.pathname, import.meta.url),
      );
      const data = await Deno.readTextFile(path);
      const contentType = url.pathname.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8";

      return new Response(data, { headers: { "content-type": contentType } });
    }

    return new Response("Not found", { status: 404 });
  });

  console.error(
    `Serving Spry Ontology at ${serverUrl} (Ctrl+C to stop)`,
  );

  if (launchBrowser) {
    openBrowser(`${serverUrl}/`).catch((err) => {
      console.error("Failed to open browser:", err?.message ?? err);
    });
  }

  // Kick off the initial build in the background so startup stays fast.
  (async () => {
    const ok = await renderOnce?.();
    if (ok) {
      broadcastReload();
    }
  })();

  if (watchTargets?.length) {
    console.error(
      `Watching for changes in: ${
        watchTargets.map((f) => relative(Deno.cwd(), f)).join(", ")
      }`,
    );
    for await (const ev of Deno.watchFs(watchTargets)) {
      if (
        ev.kind === "modify" ||
        ev.kind === "create" ||
        ev.kind === "remove"
      ) {
        console.error(
          `Change detected, rebuilding ontology (kind=${ev.kind})`,
        );
        const ok = await renderOnce?.();
        if (!ok) continue;
        broadcastReload();
      }
    }
  } else {
    // nothing to watch; keep process alive
    await new Promise(() => {});
  }
}

// deno-lint-ignore require-await
async function openBrowser(url: string): Promise<void> {
  let cmd: string[];
  switch (Deno.build.os) {
    case "windows":
      cmd = ["cmd", "/c", "start", "", url];
      break;
    case "darwin":
      cmd = ["open", url];
      break;
    default:
      cmd = ["xdg-open", url];
      break;
  }

  try {
    const proc = new Deno.Command(cmd[0], { args: cmd.slice(1) }).spawn();
    void proc; // fire-and-forget
  } catch (err) {
    console.error("Unable to open browser automatically:", String(err) ?? err);
  }
}

export class CLI {
  constructor(
    readonly conf?: {
      readonly defaultFiles?: string[];
    },
  ) {
  }

  async run(args = Deno.args) {
    await this.rootCmd().parse(args);
  }

  rootCmd() {
    return new Command()
      .name("ontology.ts")
      .version(() => computeSemVerSync(import.meta.url))
      .description(`Spry ontology controller`)
      .command("help", new HelpCommand())
      .command("completions", new CompletionsCommand())
      .command("web-ui", this.docCommand());
  }

  protected baseCommand({ examplesCmd }: { examplesCmd: string }) {
    const { defaultFiles } = this.conf ?? {};
    return new Command()
      .example(
        `default ${
          (defaultFiles?.length ?? 0) > 0 ? `(${defaultFiles?.join(", ")})` : ""
        }`,
        `${examplesCmd}`,
      )
      .example(
        "load md from local fs",
        `${examplesCmd} ./runbook.md`,
      )
      .example(
        "load md from remote URL",
        `${examplesCmd} https://SpryMD.org/runbook.md`,
      )
      .example(
        "load md from multiple",
        `${examplesCmd} ./runbook.d https://qualityfolio.dev/runbook.md another.md`,
      );
  }

  docCommand(cmdName = "web-ui") {
    return this.baseCommand({ examplesCmd: cmdName })
      .description(
        "Serve the markdown mdasts and Spry Ontology Graphs (SOGs)",
      )
      .arguments("[paths...:string]")
      .option(
        "--port <port:number>",
        "port for web server (default 9876)",
      )
      .option(
        "--listen <addr:string>",
        "address/interface for web serve (default 127.0.0.1)",
      )
      .option(
        "--no-open",
        "when starting server, do not automatically open a browser",
      )
      .action(async (options, ...paths: string[]) => {
        await serve({
          port: options.port,
          host: options.listen,
          mdSources: paths.length ? paths : this.conf?.defaultFiles ?? [],
          launchBrowser: options.open,
        });
      });
  }
}

if (import.meta.main) {
  new CLI().run();
}
