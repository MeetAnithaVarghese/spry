import { basename } from "jsr:@std/path@^1";
import z from "jsr:@zod/zod@4";
import { MarkdownDoc } from "../markdown/fluent-doc.ts";
import {
  fbPartialsCollection,
  Issue,
  isVirtualDirective,
  parsedTextFlags,
  PlaybookCodeCell,
  Source,
} from "../markdown/notebook/mod.ts";
import {
  annotationsFactory,
  TaskDirectiveInspector,
  TaskDirectives,
  TasksProvenance,
} from "../task/cell.ts";
import {
  ensureLanguageByIdOrAlias,
  getLanguageByIdOrAlias,
  LanguageSpec,
} from "../universal/code.ts";
import {
  safeSourceText,
  SourceRelativeTo,
} from "../universal/content-acquisition.ts";
import { unsafeInterpolator } from "../universal/interpolate.ts";
import { forestToStatelessViews } from "../universal/path-tree-tabular.ts";
import { raw as rawSQL, SQL, sqlCat } from "../universal/sql-text.ts";
import { safeJsonStringify } from "../universal/tmpl-literal-aide.ts";
import { dropUndef } from "./conf.ts";
import {
  isSqlPageContent,
  SqlPageContent,
  sqlPageContentHelpers,
  SqlPageFileUpsert,
  sqlPagePathsFactory,
} from "./content.ts";
import * as interp from "./interpolate.ts";
import { markdownLinkFactory } from "./interpolate.ts";
import {
  isRouteSupplier,
  muateRoutePaths,
  PageRoute,
  pageRouteSchema,
  RoutesBuilder,
} from "./route.ts";

export type SqlPageProvenance = TasksProvenance;
export type SqlPageFrontmatter = Record<string, unknown> & {
  "sqlpage-conf"?: Record<string, unknown>;
};
export type SqlPageCellAttrs = Record<string, unknown>;
export type SqlPageIssue = Issue<SqlPageProvenance>;
export type SqlPageTDI = TaskDirectiveInspector<
  SqlPageProvenance,
  SqlPageFrontmatter,
  SqlPageCellAttrs,
  SqlPageIssue
>;

export const sqlCodeCellLangId = "sql" as const;
export const sqlCodeCellLangSpec = ensureLanguageByIdOrAlias(sqlCodeCellLangId);

export const sqlTaskHead = "HEAD" as const;
export const sqlTaskTail = "TAIL" as const;
export const sqlTaskSqlPageFileUpsert = "sqlpage_file-upsert" as const;
export const sqlTaskNature = [
  sqlTaskHead,
  sqlTaskTail,
  sqlTaskSqlPageFileUpsert,
] as const;
export type SqlTaskNature = typeof sqlTaskNature[number];

export function counter<Identifier>(identifier: Identifier, padValue = 4) {
  let value = -1;
  const incr = () => ++value;
  const nextPadded = () => String(incr()).padStart(padValue, "0");
  const nextText = (text = `${identifier}-`) =>
    `${text}${String(incr()).padStart(padValue, "0")}`;
  return { identifier, incr, nextPadded, nextText };
}

/**
 * Adjust the `parsedInfo` of a virtual import cell when it matches
 * a **virtual HEAD or TAIL directive**.
 *
 * This helper normalizes generated import cells that come from
 * patterns such as:
 *
 * ```markdown
 * ```import
 * sql **\/*.sql HEAD
 * sql **\/*.sql TAIL
 * ```
 * ```
 *
 * When an imported cell is marked as "virtual" and its first token in
 * `restParts` equals the provided `match` value (case-insensitive),
 * the function rewrites its `parsedInfo` tokens to follow a canonical
 * structure:
 *
 * - `firstToken` → `"HEAD"` or `"TAIL"`
 * - `secondToken` → `"sql.d/{head|tail}/{originalFirstToken}"`
 * - `bareTokens` → `[firstToken, secondToken]`
 *
 * This makes it easier for downstream SQLPage or Spry emitters to
 * distinguish special pseudo-cells (HEAD/TAIL) from normal SQL imports.
 *
 * @param cell The virtual code cell to modify (must have `parsedInfo`)
 * @param match The directive keyword to look for (e.g. `"HEAD"` or `"TAIL"`)
 *
 * @example
 * ```ts
 * fixupVirtualHeadTail(cell, "HEAD");
 * // transforms:
 * //   firstToken: "migrations/init.sql"
 * // into:
 * //   firstToken: "HEAD"
 * //   secondToken: "sql.d/head/migrations/init.sql"
 * ```
 */
export function fixupVirtualHeadTail(
  cell: PlaybookCodeCell<string, SqlPageCellAttrs>,
  match: string,
) {
  if (isVirtualDirective(cell) && cell.parsedInfo) {
    // might look like `sql **/*.sql HEAD` or `sql **/*.sql TAIL`
    // restParts is string tokens that come after the glob / remote
    const firstGenDirecToken = cell.virtualDirective.restParts[0];
    if (firstGenDirecToken.toUpperCase() == match.toUpperCase()) {
      // switch to `sql HEAD file.sql` or `sql TAIL file.sql`
      cell.parsedInfo.secondToken =
        `sql.d/${match.toLowerCase()}/${cell.parsedInfo.firstToken}`;
      cell.parsedInfo.firstToken = match;
      cell.parsedInfo.bareTokens = [
        cell.parsedInfo.firstToken,
        cell.parsedInfo.secondToken,
      ];
    }
  }
}

export function sqlHeadCellTDI(): SqlPageTDI {
  const heads = counter(sqlTaskHead);
  return ({ cell }) => {
    if (cell.language != sqlCodeCellLangId) return false;
    fixupVirtualHeadTail(cell, sqlTaskHead);
    const pi = cell.parsedInfo;
    if (!pi) return false; // no identity, ignore
    if (pi.firstToken?.toLocaleUpperCase() != sqlTaskHead) return false;
    const identity = pi.bareTokens[1] ?? `sql.d/head/${heads.nextText()}.sql`;
    return {
      nature: "CONTENT",
      identity,
      content: {
        kind: "head_sql",
        path: identity,
        contents: cell.source,
        cell,
      } satisfies SqlPageContent,
      language: sqlCodeCellLangSpec,
    };
  };
}

export function sqlTailCellTDI(): SqlPageTDI {
  const tails = counter(sqlTaskTail);
  return ({ cell }) => {
    if (cell.language != sqlCodeCellLangId) return false;
    fixupVirtualHeadTail(cell, sqlTaskTail);
    const pi = cell.parsedInfo;
    if (!pi) return false; // no identity, ignore
    if (pi.firstToken?.toLocaleUpperCase() != sqlTaskTail) return false;
    const identity = pi.bareTokens[1] ?? `sql.d/tail/${tails.nextText()}.sql`;
    return {
      nature: "CONTENT",
      identity,
      content: {
        kind: "tail_sql",
        path: identity,
        contents: cell.source,
        cell,
      } satisfies SqlPageContent,
      language: sqlCodeCellLangSpec,
    };
  };
}

export function mutateRouteInCellAttrs(
  cell: PlaybookCodeCell<string, SqlPageCellAttrs>,
  identity: string,
  registerIssue?: (message: string, error?: unknown) => void,
  candidateAnns?: unknown, // if routes were supplied in annotation
) {
  const validated = (route: unknown) => {
    const parsed = z.safeParse(pageRouteSchema, route);
    if (!parsed.success) {
      registerIssue?.(
        `Zod error parsing route: ${z.prettifyError(parsed.error)}`,
        parsed.error,
      );
      return false;
    }
    return true;
  };

  // if no route was supplied in the cell attributes, use what's in annotations
  if (!isRouteSupplier(cell.attrs)) {
    if (candidateAnns) cell.attrs.route = candidateAnns;
    const mrp = muateRoutePaths(cell.attrs.route as PageRoute, identity);
    return mrp || validated(cell.attrs.route);
  }

  // if route was supplied in the cell attributes, merge with annotations with
  // what's in the annotations overriding what's in cell attributes
  if (isRouteSupplier(cell.attrs) && candidateAnns) {
    // deno-lint-ignore no-explicit-any
    (cell.attrs as any).route = { ...cell.attrs.route, ...candidateAnns };
    const mrp = muateRoutePaths(cell.attrs.route as PageRoute, identity);
    return mrp || validated(cell.attrs.route);
  }

  return false;
}

export function typicalCellFlags(pi: ReturnType<typeof parsedTextFlags>) {
  return {
    isUnsafeInterpolatable: "I" in pi.flags || "interpolate" in pi.flags,
    isInjectableCandidate: "J" in pi.flags || "injectable" in pi.flags,
  };
}

export function sqlPageFileLangCellTDI(
  language: LanguageSpec,
  spfi:
    & Pick<
      SqlPageFileUpsert,
      "asErrorContents" | "isUnsafeInterpolatable" | "isInjectableCandidate"
    >
    & { isRoutable: boolean },
): SqlPageTDI {
  return ({ cell, registerIssue }) => {
    const langs = [language.id];
    if (language.aliases) langs.push(...language.aliases);
    if (!langs.find((l) => l === cell.language)) return false;
    const pi = cell.parsedInfo;
    if (!pi || !pi.firstToken) return false; // no identity, ignore
    const path = pi.firstToken;
    if (spfi.isRoutable) mutateRouteInCellAttrs(cell, path, registerIssue);
    return {
      nature: "CONTENT",
      identity: path,
      content: {
        kind: "sqlpage_file_upsert",
        path,
        contents: cell.source,
        cell,
        asErrorContents: spfi.asErrorContents,
        isUnsafeInterpolatable: spfi.isUnsafeInterpolatable,
        isInjectableCandidate: spfi.isInjectableCandidate,
        isBinary: false,
      } satisfies SqlPageContent,
      language,
    };
  };
}

export function sqlPageFileSqlCellTDI() {
  return sqlPageFileLangCellTDI(sqlCodeCellLangSpec, {
    asErrorContents: (text) => text.replaceAll(/^/gm, "-- "),
    isRoutable: false,
    isUnsafeInterpolatable: true,
    isInjectableCandidate: true,
  });
}

export function sqlPageFileCssCellTDI() {
  return sqlPageFileLangCellTDI(getLanguageByIdOrAlias("css")!, {
    asErrorContents: (text) => text.replaceAll(/^/gm, "// "),
    isRoutable: false,
    isUnsafeInterpolatable: true,
    isInjectableCandidate: false,
  });
}

export function sqlPageFileJsCellTDI() {
  return sqlPageFileLangCellTDI(getLanguageByIdOrAlias("js")!, {
    asErrorContents: (text) => text.replaceAll(/^/gm, "// "),
    isRoutable: false,
    isUnsafeInterpolatable: true,
    isInjectableCandidate: false,
  });
}

export function sqlPageFileAnyCellWithSpcFlagTDI(): SqlPageTDI {
  return ({ cell }) => {
    const pi = cell.parsedInfo;
    if (!pi || !pi.firstToken) return false; // no identity, ignore
    if (!("spc" in pi.flags)) return false;
    const path = pi.firstToken;
    const tcf = typicalCellFlags(pi);
    return {
      nature: "CONTENT",
      identity: path,
      content: {
        kind: "sqlpage_file_upsert",
        path,
        contents: cell.sourceElaboration?.isRefToBinary
          ? cell.sourceElaboration.rs ?? cell.source
          : cell.source,
        cell,
        asErrorContents: (supplied) => supplied,
        isBinary: cell.sourceElaboration?.isRefToBinary
          ? cell.sourceElaboration.rs ?? false
          : false,
        ...tcf,
      } satisfies SqlPageContent,
    };
  };
}

export function sqlPagePlaybookState() {
  const partials = fbPartialsCollection();
  const directives = new TaskDirectives<
    SqlPageProvenance,
    SqlPageFrontmatter,
    SqlPageCellAttrs,
    SqlPageIssue
  >(partials);
  directives.use(sqlHeadCellTDI());
  directives.use(sqlTailCellTDI());
  directives.use(sqlPageFileSqlCellTDI()); // order matters, put head/tail before SqlPageFile
  directives.use(sqlPageFileCssCellTDI());
  directives.use(sqlPageFileJsCellTDI());
  directives.use(sqlPageFileAnyCellWithSpcFlagTDI());
  const routes = new RoutesBuilder();
  const spp = sqlPagePathsFactory();
  return { directives, routes, spp, partials };
}

export type SqlPagePlaybookState = ReturnType<typeof sqlPagePlaybookState>;

export function frontmatterInterpolator<Project>(project: Project) {
  const context = () => {
    return {
      project, // fully custom, can be anything passed from project init location
      env: Deno.env.toObject(),
    };
  };

  // "unsafely" means we're using JavaScript "eval"
  async function mutateUnsafely(
    ctx: ReturnType<typeof context>,
    fmRaw: string,
    unsafeInterp: ReturnType<typeof unsafeInterpolator>,
  ) {
    try {
      // NOTE: This is intentionally unsafe. Do not feed untrusted content.
      // Assume you're treating code cell blocks as fully trusted source code.
      const mutated = await unsafeInterp.interpolate(fmRaw, ctx);
      if (mutated !== fmRaw) return mutated;
      return fmRaw;
    } catch (error) {
      return `SPRY_ERROR: "frontmatterInterpolator.mutateUnsafely"\nSPRY_ERROR_MESSAGE: "${
        String(error)
      }"\n${fmRaw}`;
    }
  }

  return { context, mutateUnsafely };
}

export function sqlPageInterpolator<Project>(project: Project) {
  const context = (state: SqlPagePlaybookState) => {
    const { directives, routes } = state;
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
      project, // fully custom, can be anything passed from project init location
      env: Deno.env.toObject(),
      state,
      directives,
      routes,
      pagination,
      absUrlQuoted: interp.absUrlQuoted,
      absUrlUnquoted: interp.absUrlUnquoted,
      absUrlUnquotedEncoded: interp.absUrlUnquotedEncoded,
      absUrlQuotedEncoded: interp.absUrlQuotedEncoded,
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
    unsafeInterp: ReturnType<typeof unsafeInterpolator>,
  ) {
    const { state: { directives } } = ctx;
    const { path } = spfu;

    let errSource: string | undefined;
    try {
      // "ic" is basically a "layout"
      const ic = spfu.isInjectableCandidate
        ? directives.partials.findInjectableForPath(path)
        : undefined;

      if (spfu.isUnsafeInterpolatable && typeof spfu.contents === "string") {
        const source = ic?.injection?.wrap(spfu.contents) ?? spfu.contents;
        errSource = source;

        const commonLocals = {
          pagination: ctx.pagination,
          paginate: ctx.paginate,
          safeJsonStringify,
          SQL,
          cat: sqlCat,
          md: ctx.md,
          raw: rawSQL,
          ...spfu.cell?.attrs,
          ...spfu,
        };

        // NOTE: This is intentionally unsafe. Do not feed untrusted content.
        // Assume you're treating code cell blocks as fully trusted source code.
        const mutated = await unsafeInterp.interpolate(source, {
          ...commonLocals,
          partial: async (
            name: string,
            partialLocals?: Record<string, unknown>,
          ) => {
            const found = directives.partials.get(name);
            if (found) {
              const partialCell = directives.partialDirectives.find((pd) =>
                pd.partialDirective.partial.identity == found.identity
              );
              const { content: partial, interpolate, locals } = await found
                .content({
                  ...partialLocals,
                  ...commonLocals,
                  partial: partialCell,
                });
              if (!interpolate) return partial;
              return await unsafeInterp.interpolate(partial, locals, [{
                template: partial,
              }]);
            } else {
              return `/* partial '${name}' not found */`;
            }
          },
        });

        if (mutated !== spfu.contents) {
          spfu.contents = String(mutated);
          spfu.isInterpolated = true;
        }
      } else if (ic && ic.injection && typeof spfu.contents === "string") {
        spfu.contents = ic.injection.wrap(spfu.contents);
      }

      if (ic) spfu.partialInjected = ic;
      return spfu;
    } catch (error) {
      spfu.error = error;
      return {
        ...spfu,
        contents: spfu.asErrorContents(
          `finalSqlPageFileEntries error: ${
            String(error)
          }\n*****\nSOURCE:\n${errSource}\n${
            safeJsonStringify({ ctx: unsafeInterp.ctx, spf: spfu }, 2)
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
    unsafeInterp: ReturnType<typeof unsafeInterpolator>,
  ) {
    if (spc.kind === "sqlpage_file_upsert") {
      return await mutateUpsertUnsafely(ctx, spc, unsafeInterp);
    }
    return spc;
  }

  return { context, mutateUpsertUnsafely, mutateContentUnsafely };
}

export class SqlPagePlaybook<Project> {
  protected constructor(readonly project: Project) {
  }

  async *sources(init: { mdSources: string[]; srcRelTo: SourceRelativeTo }) {
    const fmi = frontmatterInterpolator(this.project);
    const fmiCtx = fmi.context();
    const unsafeInterp = unsafeInterpolator(fmiCtx);

    for await (const md of init.mdSources) {
      const safeMdSrc = await safeSourceText(md, init.srcRelTo, {
        baseUrl: new URL(import.meta.url),
      });
      if (safeMdSrc.nature == "error") {
        console.error(safeMdSrc);
        continue;
      }
      yield {
        provenance: typeof safeMdSrc.source === "string"
          ? safeMdSrc.source
          : safeMdSrc.source.href,
        content: safeMdSrc.text,
        import: async (src, cell) => {
          const all = typeof src === "string" ? [src] : src;
          let result = "";
          for (const s of all) {
            const safeImportSrc = await safeSourceText(s, init.srcRelTo);
            if (safeImportSrc.nature == "error") {
              const err = safeImportSrc.error;
              return `❌ ${err.name} in import from ${cell.provenance} line ${cell.startLine}\n\n${err.message}${
                err.stack
                  ? "\n" + err.stack.split("\n").slice(1).join("\n")
                  : ""
              }`;
            }
            result += safeImportSrc.text;
          }
          return result;
        },
        transformFrontmatter: (fmRaw) =>
          fmi.mutateUnsafely(fmiCtx, fmRaw, unsafeInterp),
      } satisfies Source<SqlPageProvenance>;
    }
  }

  async populateContent(
    init: {
      mdSources: string[];
      srcRelTo: SourceRelativeTo;
      state: SqlPagePlaybookState;
    },
  ) {
    const { state } = init;
    const { directives: td } = state;

    /*  Markdown Files' Fenced Cells
        ↓
        NotebookCodeCell (syntactic)
           ↓
           PlaybookCodeCell (contextual)
               ↓
               TaskDirective (semantic)
                   ↓
                   Task / TaskCell (executable)
                       ↓
                       TASK (executable)
                       CONTENT (optionally executable) */

    // directives now has all the tasks/content across all notebooks in memory
    await td.populate(() => this.sources(init));

    const spInterpolator = sqlPageInterpolator(this.project);
    const spiContext = spInterpolator.context(state);
    const unsafeInterp = unsafeInterpolator(spiContext);
    const routeAnnsF = annotationsFactory({
      language: sqlCodeCellLangSpec,
      prefix: "route.",
    });

    return {
      state,
      spInterpolator,
      spiContext,
      unsafeInterp,
      routeAnnsF,
    };
  }

  async *sqlPageFiles(
    init: {
      mdSources: string[];
      srcRelTo: SourceRelativeTo;
      state: SqlPagePlaybookState;
    },
  ) {
    const p = await this.populateContent(init);
    const { state, spInterpolator, spiContext, unsafeInterp, routeAnnsF } = p;
    const { directives, routes } = state;
    const { sql: sqlSPF, json: jsonSPF } = sqlPageContentHelpers();

    for (const pb of directives.playbooks) {
      yield sqlSPF(
        `spry.d/auto/frontmatter/${basename(pb.notebook.provenance)}.auto.json`,
        JSON.stringify(pb.notebook.fm, null, 2),
      );
    }

    for (const pd of directives.partialDirectives) {
      yield sqlSPF(
        `spry.d/auto/partial/${pd.partialDirective.partial.identity}.auto.sql`,
        `-- ${safeJsonStringify(pd)}\n${pd.partialDirective.partial.source}`,
        { isPartial: true, cell: pd },
      );
    }

    const { mutateContentUnsafely } = spInterpolator;
    for await (const t of directives.tasks) {
      const { taskDirective: td } = t;
      if (td.nature === "CONTENT" && isSqlPageContent(td.content)) {
        const mutated = await mutateContentUnsafely(
          spiContext,
          td.content,
          unsafeInterp,
        );
        if (typeof mutated.contents === "string") {
          // see if any @route.* annotations are supplied in the mutated content
          // and merge them with existing { route: {...} } cell
          const route = routeAnnsF.transform(
            await routeAnnsF.catalog(mutated.contents),
          );
          if (route) mutateRouteInCellAttrs(t, mutated.path, undefined, route);
        }
        yield mutated;
        if (td.content.cell) {
          const cell = td.content.cell;
          yield jsonSPF(
            `spry.d/auto/cell/${td.content.path}.auto.json`,
            safeJsonStringify(cell, 2),
            { cell, isAutoGenerated: true },
          );
          if (cell.instructions) {
            yield jsonSPF(
              `spry.d/auto/instructions/${td.content.path}.auto.md`,
              cell.instructions.markdown,
              { cell, isAutoGenerated: true },
            );
          }
          if (Object.entries(cell.attrs).length) {
            yield jsonSPF(
              `spry.d/auto/resource/${td.content.path}.auto.json`,
              JSON.stringify(dropUndef(cell.attrs), null, 2),
              { cell, isAutoGenerated: true },
            );
          }
        }
      }

      // now that all content mutations (template replacements) are completed,
      // build the routes tree from anything with { route: {...} } in fenced
      // attrs or @route annotations
      if (isRouteSupplier(t.attrs)) {
        routes.encounter(t.attrs.route as PageRoute);
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

    yield jsonSPF(`spry.d/README.md`, this.dropInAutoReadme().write(), {
      isAutoGenerated: true,
    });

    return p;
  }

  // deno-fmt-ignore
  protected dropInAutoReadme() {
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

  static instance<Project>(project: Project) {
    return new SqlPagePlaybook(project);
  }
}
