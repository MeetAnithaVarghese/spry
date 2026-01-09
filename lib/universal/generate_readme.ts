
import { MarkdownDoc } from "./fluent-md.ts";

const md = new MarkdownDoc();
md.h1("@spry/universal");
md.p("Universal utilities for Spry core, compatible with Deno and other environments.");

md.h2("Modules");
md.ul(
    "annotations",
    "code-comments",
    "code",
    "collectable",
    "depends",
    "directive",
    "doctor",
    "event-bus",
    "flexible-interpolator",
    "flexible-pattern",
    "fluent-md",
    "gitignore",
    "json-stringify-aide",
    "lister-tabular-tui",
    "lister-tree-tui",
    "os-user",
    "path-tree-tabular",
    "path-tree",
    "pmd-shebang",
    "posix-pi",
    "render",
    "resource-contributions",
    "resource",
    "reverse-proxy-simulate",
    "route",
    "sql-text",
    "tabular-json",
    "task-visuals",
    "task",
    "text-utils",
    "tmpl-literal-aide",
    "unsafe-js-expr",
    "version",
    "watcher",
    "zod-aide"
);

// Output the markdown
if (import.meta.main) {
    console.log(md.write());
}
