import { expandGlob, WalkEntry } from "jsr:@std/fs@^1";
import { relative } from "jsr:@std/path@^1";
import {
  isTextHttpUrl,
  lazyFileBytesReader,
  lazyUrlBytesReader,
  relativeUrlAsFsPath,
} from "../../universal/content-acquisition.ts";
import { CodeCell, Issue, parsedTextFlags } from "./notebook.ts";
import { Playbook, PlaybookCell } from "./playbook.ts";

export function isVirtualDirective<
  Provenance,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
>(
  cc: CodeCell<Provenance, CellAttrs>,
): cc is CodeCell<Provenance, CellAttrs> & {
  virtualDirective: Awaited<ReturnType<typeof parseCellsFromSpec>>[number];
} {
  return "virtualDirective" in cc ? true : false;
}

/**
 * Parse a multi-line `import` spec and return **lazy** directives for
 * local filesystem globs and HTTP(S) URLs.
 *
 * Input rules:
 * - One directive per non-comment line: `<language> <globOrUrl> [tokens…]`
 * - Lines starting with `#` are ignored
 * - Local globs expand to one directive **per matched file** (per base)
 * - URLs yield **one** directive each
 *
 * Laziness:
 * - `asText()` loads full text on demand
 * - `asUtf8Reader()` returns a deferred binary stream for large files
 *
 * @param spec   The raw fence body (import directives)
 * @param baseDir One or more bases used to resolve local globs
 * @returns Array of **lazy** directives (local or remote)
 */
export async function parseCellsFromSpec(
  spec: string,
  baseDir: string | string[],
) {
  // Single self-contained Directive type (as requested)
  type Directive =
    & {
      kind: "local" | "remote";
      line: number;
      language: string;
      restParts: string[];
      asText: () => Promise<string>;
      asUtf8Reader: () => ReadableStream<Uint8Array>; // binary, lazy
    }
    & (
      | { kind: "local"; glob: string; we: WalkEntry; baseDir: string }
      | { kind: "remote"; url: string; base: string }
    );

  const dirs = Array.isArray(baseDir) ? baseDir : [baseDir];
  const out: Directive[] = [];
  const lines = spec.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;

    const [language, globOrUrl, ...restParts] = raw.split(/\s+/);
    if (!language || !globOrUrl) continue;

    // URL directive: single item
    if (isTextHttpUrl(globOrUrl)) {
      const url = globOrUrl;
      out.push({
        kind: "remote",
        line: i + 1,
        language,
        url,
        restParts,
        base: typeof baseDir === "string" ? baseDir : baseDir[0],
        asText: async () => {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
          return await res.text();
        },
        asUtf8Reader: () => lazyUrlBytesReader(url),
      });
      continue;
    }

    // Local FS glob: one directive per matched file (with its originating baseDir)
    for (const dir of dirs) {
      for await (
        const we of expandGlob(globOrUrl, {
          root: dir,
          includeDirs: false,
          globstar: true,
          extended: true,
        })
      ) {
        out.push({
          kind: "local",
          line: i + 1,
          language,
          glob: globOrUrl,
          we,
          restParts,
          baseDir: dir,
          asText: async () => await Deno.readTextFile(we.path),
          asUtf8Reader: () => lazyFileBytesReader(we.path),
        });
      }
    }
  }

  return out;
}

/**
 * Create the "pseudo cells" virtual cell generator expansion helpers.
 *
 * This factory returns helpers that parse an `import`-style spec (one directive per line)
 * and yield synthetic code cells that Spry can insert into the Markdown stream.
 *
 * How it works:
 * - `parseCellsFromSpec()` tokenizes the spec, resolves **local globs** (via `expandGlob`)
 *   and recognizes **HTTP(S) URLs** (one directive per URL).
 * - Each directive exposes:
 *   - `asText()` — resolves to full UTF-8 text for text-like languages
 *   - `asUtf8Reader()` — returns a **lazy** `ReadableStream<Uint8Array>` for binary import
 * - `cellsFrom()` converts directives into `CodeCell`s (including binary hints for `utf8`).
 *
 * Typical usage:
 *   1) Author writes a fenced block with `language: import` and optional `--base` flags.
 *   2) The parser invokes `cellsFrom()` to expand items into real fenced code cells.
 *
 * @typeParam Provenance - Your provenance type carried through Notebook/Playbook
 * @typeParam Frontmatter - Notebook frontmatter shape
 * @typeParam CellAttrs - Additional per-cell attributes
 * @typeParam I - Issue type used by the Playbook/Notebook
 * @returns An object with `{ parseCellsFromSpec, cellsFrom }`
 */
export function pseudoCellsGenerator<
  Provenance,
  Frontmatter extends Record<string, unknown> = Record<string, unknown>,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>() {
  /**
   * Expand a single `import` code cell into a stream of **materialized code cells**.
   *
   * - Honors `--base` (or `--baseDir`) flags on the source cell
   * - Emits `utf8` cells as **binary references** (with metadata) and others as text
   * - Fills `parsedInfo` with relative/URL-derived first token and flags:
   *   - `"is-binary"`: boolean hint for downstream emitters
   *   - `import`: original absolute path or URL
   *
   * @param cell The original `import` Playbook code cell
   * @param pb   The containing Playbook (needed for provenance)
   * @yields Fully formed `CodeCell` entries ready for insertion
   */
  async function* cellsFrom(
    cell: Extract<PlaybookCell<Provenance, CellAttrs>, { kind: "code" }>,
    pb: Playbook<Provenance, Frontmatter, CellAttrs, I>,
  ) {
    const suppliedBase = cell.parsedInfo?.flags["base"] ??
      cell.parsedInfo?.flags["baseDir"];
    let base: string | string[];
    if (!suppliedBase) {
      base = Deno.cwd();
    } else {
      if (typeof suppliedBase === "boolean") {
        base = Deno.cwd();
      } else {
        base = suppliedBase;
      }
    }

    const genDirecs = await parseCellsFromSpec(cell.source, base);
    for (const gd of genDirecs) {
      const { language, kind } = gd;
      const isBinaryHint = language === "utf8";

      let info: (typeof cell)["info"];
      let source: (typeof cell)["source"];
      let sourceElaboration: (typeof cell)["sourceElaboration"];
      switch (kind) {
        case "local":
          {
            const firstToken = relative(gd.baseDir, gd.we.path);
            // deno-fmt-ignore
            info = `${firstToken} --import ${gd.we.path}${isBinaryHint ? " --is-binary" : ""} ${gd.restParts.join(" ")}`.trim();
            source = isBinaryHint ? JSON.stringify(gd) : await gd.asText();
            sourceElaboration = isBinaryHint
              ? {
                isRefToBinary: true,
                encoding: "UTF-8",
                importedFrom: gd.we.path,
                rs: gd.asUtf8Reader(),
              }
              : {
                isRefToBinary: false,
                importedFrom: gd.we.path,
                original: source,
              };
          }
          break;

        case "remote":
          {
            const firstToken = relativeUrlAsFsPath(gd.base, gd.url);
            // deno-fmt-ignore
            info = `${firstToken} --import ${gd.url}${isBinaryHint ? " --is-binary" : ""} ${gd.restParts.join(" ")}`.trim();
            source = isBinaryHint ? JSON.stringify(gd) : await gd.asText();
            sourceElaboration = isBinaryHint
              ? {
                isRefToBinary: true,
                encoding: "UTF-8",
                importedFrom: gd.url,
                rs: gd.asUtf8Reader(),
              }
              : {
                isRefToBinary: false,
                importedFrom: gd.url,
                original: source,
              };
          }
          break;
      }

      yield {
        kind: "code",
        language,
        attrs: {} as CellAttrs,
        provenance: pb.notebook.provenance,
        source,
        info,
        parsedInfo: parsedTextFlags(info),
        sourceElaboration,
        isVirtual: true,
        suppliedBase,
        virtualDirective: gd,
        startLine: (cell.startLine ?? 0) + gd.line,
        endLine: (cell.startLine ?? 0) + gd.line,
      } satisfies CodeCell<Provenance, CellAttrs> & {
        suppliedBase: typeof suppliedBase;
        virtualDirective: typeof gd;
      };
    }
  }

  return {
    cellsFrom,
    isVirtualDirective: isVirtualDirective<Provenance, CellAttrs>,
  };
}
