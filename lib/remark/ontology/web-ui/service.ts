#!/usr/bin/env -S deno run -A --node-modules-dir=auto
// service.ts
//
// Deno entrypoint for the Spry Graph Viewer.
// - Reads Markdown fixture(s)
// - Runs the Ontology Graphs and Edges rule pipeline
// - Builds a GraphViewerModel (graph-centric JSON)
// - Injects that JSON into index.html and serves it via Deno.serve

import { fromFileUrl } from "@std/path";
import { buildGraphViewerModelFromFiles } from "./model.ts";

async function buildInjectedHtml(): Promise<string> {
  const htmlTemplate = await Deno.readTextFile(
    fromFileUrl(new URL("./index.html", import.meta.url)),
  );

  const model = await buildGraphViewerModelFromFiles([
    fromFileUrl(
      new URL("../../fixture/test-fixture-01.md", import.meta.url),
    ),
  ]);

  const json = JSON.stringify(model);

  // Replace the placeholder script tag with inline JSON
  const injectedHtml = htmlTemplate.replace(
    /<script type="application\/json" id="web-ui\.model\.json"><\/script>/,
    `<script type="application/json" id="web-ui.model.json">${json}</script>`,
  );

  return injectedHtml;
}

const injectedHtml = await buildInjectedHtml();

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(injectedHtml, {
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
