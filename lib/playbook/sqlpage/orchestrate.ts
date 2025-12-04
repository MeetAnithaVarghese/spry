import z from "@zod/zod";
import {
  isMaterializable,
  Materializable,
  PlaybookProjection,
  playbooksFromFiles,
} from "../../axiom/projection/playbook.ts";
import { docFrontmatterDataBag } from "../../axiom/remark/doc-frontmatter.ts";
import { unsafeInterpFactory } from "../../interpolate/unsafe.ts";
import { annotationsFactory } from "../../universal/annotations.ts";
import { MarkdownDoc } from "../../universal/fluent-md.ts";
import { forestToStatelessViews } from "../../universal/path-tree-tabular.ts";
import {
  isRouteSupplier,
  PageRoute,
  RoutesBuilder,
} from "../../universal/route.ts";
import { raw as rawSQL, SQL, sqlCat } from "../../universal/sql-text.ts";
import { safeJsonStringify } from "../../universal/tmpl-literal-aide.ts";
import { dropUndef } from "./conf.ts";
import {
  contentSuppliers,
  mutateRouteInCellAttrs,
  sqlCodeCellLangSpec,
  SqlPageContent,
  SqlPageFileUpsert,
  SqlPageHeadOrTail,
  sqlPagePathsFactory,
} from "./content.ts";
import * as interp from "./interpolate.ts";
import { markdownLinkFactory } from "./interpolate.ts";

export function sqlPageInterpolator() {
  const context = (playbook: PlaybookProjection) => {
    const pagination = {
      active: undefined as undefined | ReturnType<typeof interp.pagination>,
      prepare: interp.pagination,
      debug: `/* \${paginate("tableOrViewName")} not called yet*/`,
      limit: `/* \${paginate("tableOrViewName")} not called yet*/`,
      navigation: `/* \${paginate("tableOrViewName")} not called yet*/`,
      navWithParams: (..._extraQueryParams: string[]) =>
        `/* \${paginate("tableOrViewName")} not called yet*/`,
    };

    return {
      env: Deno.env.toObject(),
      pagination,
      playbook,
      absUrlQuoted: interp.absUrlQuoted,
      absUrlUnquoted: interp.absUrlUnquoted,
      absUrlUnquotedEncoded: interp.absUrlUnquotedEncoded,
      absUrlQuotedEncoded: interp.absUrlQuotedEncoded,
      breadcrumbs: interp.breadcrumbs,
      sitePrefixed: interp.absUrlQuoted,
      md: markdownLinkFactory({ url_encode: "replace" }),
      rawSQL,
      sqlCat,
      SQL,
      paginate: (tableOrViewName: string, whereSQL?: string) => {
        const pn = interp.pagination({ tableOrViewName, whereSQL });
        pagination.active = pn;
        pagination.debug = pn.debugVars();
        pagination.limit = pn.limit();
        pagination.navigation = pn.navigation();
        pagination.navWithParams = pn.navigation;
        return pagination.active.init();
      },
    };
  };

  // "unsafely" means we're using JavaScript "eval"
  async function mutateUpsertUnsafely(
    ctx: ReturnType<typeof context>,
    spfu: SqlPageFileUpsert,
  ) {
    const { playbook: { partials } } = ctx;
    const unsafeInterp = unsafeInterpFactory({
      partialsCollec: partials,
      interpCtx: (purpose) => {
        switch (purpose) {
          case "default":
            return ctx;
          case "prime":
          case "partial":
            return {
              pagination: ctx.pagination,
              paginate: ctx.paginate,
              safeJsonStringify,
              SQL,
              cat: sqlCat,
              md: ctx.md,
              raw: rawSQL,
              ...(spfu.cell
                ? (isMaterializable(spfu.cell)
                  ? spfu.cell.materializationAttrs
                  : {})
                : {}),
              ...spfu,
            };
        }
      },
    });

    let errSource: string | undefined;
    try {
      if (spfu.isUnsafeInterpolatable && typeof spfu.contents === "string") {
        const { interpolateUnsafely } = unsafeInterp;
        const interpResult = await interpolateUnsafely({
          spfu,
          source: spfu.contents,
          interpolate: spfu.isUnsafeInterpolatable,
        });
        if (interpResult.status === "mutated") {
          spfu.contents = String(interpResult.source);
          spfu.isInterpolated = true;
        }
      }

      return spfu;
    } catch (error) {
      spfu.error = error;
      return {
        ...spfu,
        contents: spfu.asErrorContents(
          `finalSqlPageFileEntries error: ${
            String(error)
          }\n*****\nSOURCE:\n${errSource}\n${
            safeJsonStringify({ ctx, spf: spfu }, 2)
          }`,
          error,
        ),
      };
    }
  }

  // "unsafely" means we're using JavaScript "eval"
  async function mutateContentUnsafely(
    ctx: ReturnType<typeof context>,
    spc: SqlPageContent,
  ) {
    if (spc.kind === "sqlpage_file_upsert") {
      return await mutateUpsertUnsafely(ctx, spc);
    }
    return spc;
  }

  return { context, mutateUpsertUnsafely, mutateContentUnsafely };
}

export async function* sqlPageFiles(
  playbook: Awaited<ReturnType<typeof sqlPagePlaybook>>,
) {
  const {
    sources,
    routes,
    partials,
    materializables,
    routeAnnsF,
    directives,
  } = playbook;
  const { sqlSPF, jsonSPF, handlers: csHandlers } = contentSuppliers();

  for (const src of sources) {
    if (docFrontmatterDataBag.is(src.mdastRoot)) {
      const fm = src.mdastRoot.data.documentFrontmatter.parsed.fm;
      yield sqlSPF(
        `spry.d/auto/frontmatter/${src.file.basename}.auto.json`,
        JSON.stringify(fm, null, 2),
      );
    }
  }

  for (const pc of partials.catalog.values()) {
    yield sqlSPF(
      `spry.d/auto/partial/${pc.identity}.auto.sql`,
      `-- ${safeJsonStringify(pc)}\n${pc.source}`,
      { isPartial: true, cell: pc.provenance as Materializable },
    );
  }

  for (const d of directives) {
    switch (d.directive) {
      case "HEAD":
        yield {
          contents: d.value,
          kind: "head_sql",
          path: `sql.d/head/${d.identity}.sql`,
          cell: d,
        } satisfies SqlPageHeadOrTail;
        break;

      case "TAIL":
        yield {
          contents: d.value,
          kind: "tail_sql",
          path: `sql.d/tail/${d.identity}.sql`,
          cell: d,
        } satisfies SqlPageHeadOrTail;
        break;
    }
  }

  const { mutateContentUnsafely, context } = sqlPageInterpolator();
  const spiContext = context(playbook);

  for await (const m of materializables) {
    const handlers = csHandlers(m.language);
    for (const handler of handlers) {
      const content = await handler(m, {
        registerIssue: (message, error) =>
          console.error(`ERROR: ${message} ${error}`),
      });
      if (content) {
        const spf = await mutateContentUnsafely(spiContext, content);
        if (typeof spf.contents === "string") {
          // see if any @route.* annotations are supplied in the mutated content
          // and merge them with existing { route: {...} } cell
          const route = routeAnnsF.transform(
            await routeAnnsF.catalog(spf.contents),
          );
          if (route) mutateRouteInCellAttrs(m, spf.path, undefined, route);
        }
        yield spf;
        if (isMaterializable(spf.cell)) {
          const cell = spf.cell;
          if (!cell.isBlob) {
            yield jsonSPF(
              `spry.d/auto/cell/${spf.path}.auto.json`,
              safeJsonStringify(cell, 2),
              { cell, isAutoGenerated: true },
            );
          }
          // TODO: add Markdown context "instructions" (before the cell)
          // if (cell.instructions) {
          //   yield jsonSPF(
          //     `spry.d/auto/instructions/${td.content.path}.auto.md`,
          //     cell.instructions.markdown,
          //     { cell, isAutoGenerated: true },
          //   );
          // }
          if (
            cell.materializationAttrs &&
            Object.entries(cell.materializationAttrs).length
          ) {
            yield jsonSPF(
              `spry.d/auto/resource/${spf.path}.auto.json`,
              JSON.stringify(dropUndef(cell.materializationAttrs), null, 2),
              { cell, isAutoGenerated: true },
            );
          }
        }
      }
    }

    // now that all content mutations (template replacements) are completed,
    // build the routes tree from anything with { route: {...} } in fenced
    // attrs or @route annotations
    if (isRouteSupplier(m.materializationAttrs)) {
      routes.encounter(m.materializationAttrs.route as PageRoute);
    }
  }

  const { forest, breadcrumbs, edges, serializers } = await routes.resolved();

  yield sqlSPF(
    `spry.d/auto/route/tree.auto.txt`,
    serializers.asciiTreeText({
      showPath: true,
      includeCounts: true,
    }),
    { isAutoGenerated: true },
  );
  yield jsonSPF(
    `spry.d/auto/route/forest.auto.json`,
    JSON.stringify(forest.roots, null, 2),
    { isAutoGenerated: true },
  );
  yield jsonSPF(
    `spry.d/auto/route/forest.schema.auto.json`,
    JSON.stringify(z.toJSONSchema(forest.schemas.forest), null, 2),
    { isAutoGenerated: true },
  );
  yield jsonSPF(
    `spry.d/auto/route/breadcrumbs.auto.json`,
    JSON.stringify(breadcrumbs.crumbs, null, 2),
    { isAutoGenerated: true },
  );
  yield jsonSPF(
    `spry.d/auto/route/breadcrumbs.schema.auto.json`,
    JSON.stringify(z.toJSONSchema(breadcrumbs.schema), null, 2),
    { isAutoGenerated: true },
  );
  yield jsonSPF(
    `spry.d/auto/route/edges.auto.json`,
    JSON.stringify(edges.edges, null, 2),
    { isAutoGenerated: true },
  );
  yield jsonSPF(
    `spry.d/auto/route/edges.schema.auto.json`,
    JSON.stringify(z.toJSONSchema(edges.schemas.edges), null, 2),
    { isAutoGenerated: true },
  );

  const sv = forestToStatelessViews(forest, { viewPrefix: "navigation_" });
  yield sqlSPF(`sql.d/tail/navigation.auto.sql`, sv.sql, {
    kind: "tail_sql",
  });

  yield jsonSPF(`spry.d/README.md`, dropInAutoReadme().write(), {
    isAutoGenerated: true,
  });
}

// deno-fmt-ignore
export function dropInAutoReadme() {
    const md = new MarkdownDoc();
    md.h1("Spry Dropin Resources and Routes");
    md.pTag`After annotations are parsed and validated, Spry generates the following in \`spry.d/auto\`:`;
    md.li("`../sql.d/head/*.sql` contains `HEAD` SQL files that are inserted before sqlpage_files upserts")
    md.li("`../sql.d/tail/*.sql` contains `TAIL` SQL files that are inserted after sqlpage_files upserts")
    md.li("[`../sql.d/tail/navigation.auto.sql`](../sql.d/tail/navigation.auto.sql) contains `TAIL` SQL file which describes all the JSON content in relational database format")
    md.li("`auto/cell/` directory contains each markdown source file's cells in JSON.")
    md.li("`auto/frontmatter/` directory contains each markdown source file's frontmatter in JSON (after it's been interpolated).")
    md.li("`auto/instructions/` directory contains the markdown source before each SQLPage `sql` fenced blocks individually.")
    md.li("`auto/resource/` directory contains parsed fence attributes blocks like { route: { ... } } and `@spry.*` with `@route.*` embedded annotations for each route / endpoint individually.")
    md.li("`auto/route/` directory contains route annotations JSON for each route / endpoint individually.")
    md.li("[`auto/route/breadcrumbs.auto.json`](auto/route/breadcrumbs.auto.json) contains computed \"breadcrumbs\" for each @route.* annotation.")
    md.li("[`auto/route/breadcrumbs.schema.auto.json`](auto/route/breadcrumbs.schema.auto.json) contains JSON schema for `route/breadcrumbs.auto.json`")
    md.li("[`auto/route/edges.auto.json`](auto/route/edges.auto.json) contains route edges to conveniently build graph with `forest.auto.json`.")
    md.li("[`auto/route/edges.schema.auto.json`](auto/route/edges.schema.auto.json) contains JSON schema for `route/edges.auto.json`")
    md.li("[`auto/route/forest.auto.json`](auto/route/forest.auto.json) contains full routes ('forest') in JSON format.")
    md.li("[`auto/route/forest.schema.auto.json`](auto/route/forest.schema.auto.json) JSON schema for `route/forest.auto.json`.")
    md.li("[`auto/route/tree.auto.txt`](auto/route/tree.auto.txt) contains route tree in ASCII text format.")
    return md;
  }

export async function sqlPagePlaybook(
  markdownPaths: Parameters<typeof playbooksFromFiles>[0],
  options?: Parameters<typeof playbooksFromFiles>[1],
) {
  const pbff = await playbooksFromFiles(markdownPaths, options);
  const routes = new RoutesBuilder();
  const spp = sqlPagePathsFactory();
  const routeAnnsF = annotationsFactory({
    language: sqlCodeCellLangSpec,
    prefix: "route.",
  });

  return { ...pbff, routes, spp, routeAnnsF };
}
