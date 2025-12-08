/**
 * @module md-doc-gen
 *
 * A dependency-light, fluent, type-safe Markdown generator for a single document.
 * No file I/O — just build Markdown in memory and `write()` it.
 *
 * - **Reopenable sections** with precise ordering via `.after("X")`
 * - Optional stable **heading anchors** (`<a id="..."></a>`)
 * - **Front matter** using `jsr:@std/yaml@1` (`frontMatter()` / `frontMatterOnce()`)
 * - Rich helpers: code blocks, lists, tables, quotes, links, images, checkboxes
 * - **TOC generation** with document- or section-scoped modes
 *
 * ### Quick start
 * ```ts
 * import { MarkdownDoc } from "./md-doc-gen.ts";
 *
 * const md = new MarkdownDoc({ anchors: true });
 *
 * md.frontMatterOnce({ title: "My Project", tags: ["deno", "md"] })
 *   .section("Introduction", (m) => m.p("Small description."))
 *   .section("Getting Started", (m) => m.code("bash", "deno run -A main.ts"))
 *   .section("Getting Started", (m) => m.ul("Install Deno", "Run the script"))
 *   .after("Background").section("Findings", (m) => m.p("Key results."))
 *   .section("Appendix", (m) => {
 *     m.h2("A");
 *     m.h3("B");
 *     m.toc([2, 3], { scope: "section" }); // section-scoped TOC
 *   });
 *
 * const text = md.write();
 * ```
 */
import { stringify as yamlStringify } from "@std/yaml";
import { stringifyYamlWithQuotes } from "./text-utils.ts";

export type Eol = "\n" | "\r\n";
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** JSON/YAML-safe values you’re comfortable serializing into front matter. */
export type YamlPrimitive = string | number | boolean | null;
export type YamlValue =
  | YamlPrimitive
  | readonly YamlValue[]
  | { readonly [k: string]: YamlValue };
export type FrontMatter = Readonly<Record<string, YamlValue>>;

type SectionKey = string;
const ROOT_KEY = "__root__";

type SectionBuf = {
  title?: string;
  id?: string;
  level?: HeadingLevel;
  lines: string[];
};

type DocBuf = {
  order: SectionKey[]; // ROOT first
  sections: Map<SectionKey, SectionBuf>;
  titleToKey: Map<string, SectionKey>;
  frontMatterEmitted: boolean;
};

export interface MarkdownOptions {
  /** Line endings for the final document. Default: "\n". */
  eol?: Eol;
  /** If true, emit `<a id="slug"></a>` before section and ad-hoc headings. */
  anchors?: boolean;
}

/**
 * Single-document fluent Markdown builder.
 * Holds an in-memory buffer of sections and headings; `write()` materializes a string.
 */
export class MarkdownDoc {
  constructor(opts?: MarkdownOptions) {
    this.eol = opts?.eol ?? "\n";
    this.anchors = opts?.anchors ?? false;

    this.doc = {
      order: [ROOT_KEY],
      sections: new Map([[ROOT_KEY, { lines: [] }]]),
      titleToKey: new Map(),
      frontMatterEmitted: false,
    };
  }

  // ------- configuration -------
  private readonly eol: Eol;
  private readonly anchors: boolean;

  // ------- document buffers -------
  private readonly doc: DocBuf;

  /** Captured headings for TOC; each heading knows which section it belongs to. */
  private readonly headings: Array<{
    level: HeadingLevel;
    text: string;
    id: string;
    section: SectionKey;
  }> = [];

  // active section context
  private current: SectionKey = ROOT_KEY;
  private pendingAfterKey?: SectionKey;

  // ------------- public API -------------

  /** Append raw lines to the current section. */
  raw(...lines: string[]) {
    this.pushTo(this.current, ...lines);
    return this;
  }

  /** Emit YAML front matter at the top (uses `@std/yaml`). */
  frontMatterWithQuotes(data: FrontMatter) {
    const yaml = stringifyYamlWithQuotes(yamlStringify(data).trimEnd());
    return this.raw("---", yaml, "---", "");
  }

  /** Emit front matter once; additional calls are no-ops. */
  frontMatterOnceWithQuotes(data: FrontMatter) {
    if (this.doc.frontMatterEmitted) return this;
    this.doc.frontMatterEmitted = true;
    return this.frontMatterWithQuotes(data);
  }

  /** Emit YAML front matter at the top (uses `@std/yaml`). */
  frontMatter(data: FrontMatter) {
    const yaml = yamlStringify(data).trimEnd();
    return this.raw("---", yaml, "---", "");
  }

  /** Emit front matter once; additional calls are no-ops. */
  frontMatterOnce(data: FrontMatter) {
    if (this.doc.frontMatterEmitted) return this;
    this.doc.frontMatterEmitted = true;
    return this.frontMatter(data);
  }

  /**
   * Start or reopen a named section; repeated calls append to the same section.
   * `level` = heading level (default: 2). `opts.id` overrides the generated slug.
   */
  section(
    title: string,
    build?: (m: this) => void,
    level: HeadingLevel = 2,
    opts?: { id?: string },
  ) {
    const key = this.ensureNamedSection(
      title,
      level,
      opts?.id,
      this.pendingAfterKey,
    );
    this.current = key;

    // If we came from .after(...), ensure relative order even if section pre-existed.
    if (this.pendingAfterKey) {
      this.reorderSectionAfter(key, this.pendingAfterKey);
      this.pendingAfterKey = undefined;
    }
    if (build) build(this);
    return this;
  }

  /**
   * Reorder the **next** created/opened section to be placed immediately after `title`.
   * If `title` doesn’t exist yet, a placeholder section is created.
   */
  after(
    title: string,
    levelForPlaceholder: HeadingLevel = 2,
    opts?: { id?: string },
  ) {
    const exists = this.doc.titleToKey.get(title);
    const afterKey = exists ??
      this.ensureNamedSection(title, levelForPlaceholder, opts?.id);
    this.pendingAfterKey = afterKey;
    return this;
  }

  /** Rename a section title (optionally keep previous slug/id). */
  renameSection(
    oldTitle: string,
    newTitle: string,
    opts?: { keepId?: boolean },
  ) {
    const key = this.doc.titleToKey.get(oldTitle);
    if (!key) return this;
    this.doc.titleToKey.delete(oldTitle);
    this.doc.titleToKey.set(newTitle, key);

    const sec = this.doc.sections.get(key)!;
    const oldId = sec.id ?? "";
    sec.title = newTitle;
    if (!opts?.keepId) sec.id = this.slug(newTitle);

    // Update captured headings for this section (both the section heading itself and ad-hoc)
    this.headings.forEach((h) => {
      if (h.section === key && (h.id === oldId || h.text === oldTitle)) {
        h.text = newTitle;
        if (!opts?.keepId) h.id = sec.id ?? h.id;
      }
    });
    return this;
  }

  /** Remove a section entirely (heading, content, and all ad-hoc headings in it). */
  removeSection(title: string) {
    const key = this.doc.titleToKey.get(title);
    if (!key) return this;
    this.doc.titleToKey.delete(title);
    this.doc.sections.delete(key);
    this.doc.order = this.doc.order.filter((k) => k !== key);
    this.current = this.current === key ? ROOT_KEY : this.current;
    // purge headings that belonged to this section
    for (let i = this.headings.length - 1; i >= 0; i--) {
      if (this.headings[i]?.section === key) this.headings.splice(i, 1);
    }
    return this;
  }

  /** Switch back to the root (unnamed) section. */
  root() {
    this.current = ROOT_KEY;
    return this;
  }

  // ----- ad-hoc headings within the current section -----

  /** Emit a heading at an arbitrary level in the current section. */
  title(level: HeadingLevel, text: string, opts?: { id?: string }) {
    const id = opts?.id ?? this.slug(text);
    if (this.anchors) this.raw(`<a id="${id}"></a>`);
    this.headings.push({ level, text, id, section: this.current });
    return this.raw(`${"#".repeat(level)} ${text}`, "");
  }
  h1(t: string, o?: { id?: string }) {
    return this.title(1, t, o);
  }
  h2(t: string, o?: { id?: string }) {
    return this.title(2, t, o);
  }
  h3(t: string, o?: { id?: string }) {
    return this.title(3, t, o);
  }
  h4(t: string, o?: { id?: string }) {
    return this.title(4, t, o);
  }
  h5(t: string, o?: { id?: string }) {
    return this.title(5, t, o);
  }
  h6(t: string, o?: { id?: string }) {
    return this.title(6, t, o);
  }

  // ----- paragraphs & spacing -----
  p(text: string) {
    return this.raw(text, "");
  }
  pTag(strings: TemplateStringsArray, ...values: unknown[]) {
    return this.p(this.dedent(strings, ...values));
  }
  /** Markdown soft break: two spaces at end of previous line. */
  br() {
    this.softBreak(this.current);
    return this;
  }
  hr() {
    return this.raw("---", "");
  }

  // ----- emphasis & inline code -----
  bold(text: string) {
    return this.raw(`**${text}**`);
  }
  italic(text: string) {
    return this.raw(`*${text}*`);
  }
  strike(text: string) {
    return this.raw(`~~${text}~~`);
  }
  codeInline(text: string) {
    return this.raw("`" + text.replace(/`/g, "\\`") + "`");
  }

  // ----- code blocks -----
  code(lang: string | undefined, ...lines: string[]) {
    const body = lines.length ? lines : [""];
    const fence = this.fenceFor(body);
    return this.raw(`${fence}${lang ?? ""}`, ...body, fence, "");
  }
  codeTag(lang?: string) {
    return (strings: TemplateStringsArray, ...values: unknown[]) => {
      const body = this.dedent(strings, ...values);
      const lines = body ? body.split(/\r?\n/) : [""];
      return this.code(lang, ...lines);
    };
  }

  // ----- lists -----
  ul(...items: string[]) {
    items.forEach((it) => this.raw(`- ${it}`));
    return this.raw("");
  }
  ol(...items: string[]) {
    items.forEach((it, i) => this.raw(`${i + 1}. ${it}`));
    return this.raw("");
  }
  li(text: string, indent = 0, ordered = false, idx = 1) {
    const pad = "  ".repeat(indent);
    const bullet = ordered ? `${idx}.` : "-";
    return this.raw(`${pad}${bullet} ${text}`);
  }
  nested(indent: number, ordered = false, ...items: string[]) {
    items.forEach((it, i) => {
      const pad = "  ".repeat(indent);
      const b = ordered ? `${i + 1}.` : "-";
      this.raw(`${pad}${b} ${it}`);
    });
    return this.raw("");
  }
  checkbox(text: string, checked = false) {
    return this.raw(`- [${checked ? "x" : " "}] ${text}`);
  }

  // ----- quotes -----
  quote(...lines: string[]) {
    if (!lines.length) return this.raw("> ");
    lines.forEach((l) => this.raw(`> ${l}`));
    return this.raw("");
  }

  // ----- links & images -----
  link(text: string, url: string, title?: string) {
    return this.raw(
      title ? `[${text}](${url} "${title}")` : `[${text}](${url})`,
    );
  }
  image(alt: string, url: string, title?: string) {
    return this.raw(
      title ? `![${alt}](${url} "${title}")` : `![${alt}](${url})`,
    );
  }

  // ----- tables -----
  private escCell(s: string) {
    return s.replaceAll("|", "\\|");
  }
  table(
    headers: readonly string[],
    rows: ReadonlyArray<ReadonlyArray<string>>,
    align?: ReadonlyArray<"left" | "center" | "right" | "-">,
  ) {
    const cols = headers.length;
    const aOf = (i: number): "left" | "center" | "right" | "-" =>
      (align && align[i]) ? align[i]! : "-";

    const renderCell = (s: string) => {
      const esc = this.escCell(String(s));
      const rendered = esc.replace(/\r?\n/g, "<br>");
      return { rendered, width: rendered.length };
    };

    const H = headers.map(renderCell);
    const R = rows.map((r) =>
      Array.from({ length: cols }, (_, i) => renderCell(r?.[i] ?? ""))
    );

    const widths = Array.from(
      { length: cols },
      (_, i) => Math.max(3, H[i].width, ...R.map((row) => row[i].width)),
    );

    const pad = (
      s: string,
      w: number,
      a: "left" | "center" | "right" | "-",
    ) => {
      const len = s.length;
      if (len >= w) return s;
      const diff = w - len;
      if (a === "right") return " ".repeat(diff) + s;
      if (a === "center") {
        const l = Math.floor(diff / 2);
        return " ".repeat(l) + s + " ".repeat(diff - l);
      }
      return s + " ".repeat(diff);
    };

    const headerLine = H.map((c, i) => pad(c.rendered, widths[i], aOf(i))).join(
      " | ",
    );
    const sepLine = widths.map((w, i) => {
      const a = aOf(i);
      if (a === "left") return ":" + "-".repeat(w - 1);
      if (a === "right") return "-".repeat(w - 1) + ":";
      if (a === "center") return ":" + "-".repeat(Math.max(1, w - 2)) + ":";
      return "-".repeat(w);
    }).join(" | ");

    this.raw(`| ${headerLine} |`, `| ${sepLine} |`);
    for (const row of R) {
      const line = row.map((c, i) => pad(c.rendered, widths[i], aOf(i))).join(
        " | ",
      );
      this.raw(`| ${line} |`);
    }
    return this.raw("");
  }

  /**
   * Generate a Table of Contents.
   * @param levels Which heading levels to include (default: [1,2,3]).
   * @param opts.scope `"doc"` (default) to include headings across the whole document,
   *                   or `"section"` to include only those in the **current section**.
   */
  toc(
    levels: ReadonlyArray<HeadingLevel> = [1, 2, 3],
    opts?: { scope?: "doc" | "section"; includeSectionHeading?: boolean },
  ) {
    const wanted = new Set(levels);
    const scope = opts?.scope ?? "doc";
    const includeSectionHeading = opts?.includeSectionHeading ?? true;

    // identify the current section id to optionally exclude it
    const cur = this.doc.sections.get(this.current);
    const currentSectionId = cur?.id;

    // filter headings by scope and levels
    const inScope = this.headings.filter((h) => {
      if (!wanted.has(h.level)) return false;
      if (scope === "section" && h.section !== this.current) return false;
      if (
        scope === "section" && !includeSectionHeading &&
        h.id === currentSectionId
      ) return false;
      return true;
    });

    if (inScope.length === 0) return this.raw("");

    // baseline indentation to the minimum heading level in this TOC block
    const baseLevel = inScope.reduce<HeadingLevel>(
      (min, h) => (h.level < min ? h.level : min),
      inScope[0]!.level,
    );

    inScope.forEach((h) => {
      const indent = "  ".repeat(h.level - baseLevel);
      this.raw(`${indent}- [${h.text}](#${h.id})`);
    });

    return this.raw("");
  }

  /** Finalize and return the document as a single Markdown string. */
  write(): string {
    const out: string[] = [];
    for (const key of this.doc.order) {
      const sec = this.doc.sections.get(key)!;
      if (key !== ROOT_KEY && sec.title && sec.level) {
        if (this.anchors && sec.id) out.push(`<a id="${sec.id}"></a>`);
        out.push(`${"#".repeat(sec.level)} ${sec.title}`, "");
      }
      if (sec.lines.length) out.push(...sec.lines);
      if (out.length && out[out.length - 1] !== "") out.push("");
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    return out.length ? out.join(this.eol) + this.eol : "";
  }

  /** Clear the current document buffers. */
  clear() {
    this.doc.order = [ROOT_KEY];
    this.doc.sections = new Map([[ROOT_KEY, { lines: [] }]]);
    this.doc.titleToKey.clear();
    this.doc.frontMatterEmitted = false;
    this.headings.length = 0;
    this.current = ROOT_KEY;
    this.pendingAfterKey = undefined;
    return this;
  }

  // ------------- internals -------------

  private pushTo(key: SectionKey, ...lines: string[]) {
    const sec = this.doc.sections.get(key);
    if (!sec) throw new Error(`Unknown section key: ${key}`);
    sec.lines.push(...lines);
  }

  /** Add a Markdown soft break (two spaces) to the end of the prior line. */
  private softBreak(key: SectionKey) {
    const sec = this.doc.sections.get(key);
    if (!sec) throw new Error(`Unknown section key: ${key}`);
    if (!sec.lines.length) {
      sec.lines.push("");
      return;
    }
    const last = sec.lines[sec.lines.length - 1] ?? "";
    sec.lines[sec.lines.length - 1] = last + "  ";
  }

  /** Ensure a named section exists and return its internal key. */
  private ensureNamedSection(
    title: string,
    level: HeadingLevel,
    id?: string,
    insertAfterKey?: SectionKey,
  ): SectionKey {
    const existing = this.doc.titleToKey.get(title);
    if (existing) return existing;

    const computedId = id ?? this.slug(title);
    const base = `sec:${computedId}`;
    let key = base;
    let n = 1;
    while (this.doc.sections.has(key)) key = `${base}-${n++}`;

    this.doc.titleToKey.set(title, key);
    this.doc.sections.set(key, { title, id: computedId, level, lines: [] });

    if (insertAfterKey && this.doc.order.includes(insertAfterKey)) {
      const idx = this.doc.order.indexOf(insertAfterKey);
      this.doc.order.splice(idx + 1, 0, key);
    } else {
      this.doc.order.push(key);
    }

    // Capture the section heading itself for TOC (belongs to this new section)
    this.headings.push({ level, text: title, id: computedId, section: key });
    return key;
  }

  /** Move section `moveKey` directly after `afterKey` (if both exist). */
  private reorderSectionAfter(moveKey: SectionKey, afterKey: SectionKey) {
    if (
      !this.doc.order.includes(moveKey) || !this.doc.order.includes(afterKey)
    ) return;
    const curIdx = this.doc.order.indexOf(moveKey);
    this.doc.order.splice(curIdx, 1);
    const afterIdx = this.doc.order.indexOf(afterKey);
    this.doc.order.splice(afterIdx + 1, 0, moveKey);
  }

  /** Generate a slug id from heading text. */
  private slug(text: string): string {
    return text.toLowerCase().trim()
      .replace(/[_~`!@#$%^&*()+={}\[\]|\\;:'",.<>/?]+/g, "")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  /**
   * Choose a backtick fence that won't collide with the content.
   * If the content contains `N` contiguous backticks, use `N+1`; otherwise use the standard ``` fence.
   */
  private fenceFor(lines: string[]): string {
    const longest = Math.max(
      0,
      ...lines.map((l) => {
        const matches = l.match(/`+/g);
        return matches ? Math.max(...matches.map((s) => s.length)) : 0;
      }),
    );
    const needed = longest > 0 ? longest + 1 : 3;
    return "`".repeat(needed);
  }

  /** Trim common indentation in template literal content. */
  private dedent(strings: TemplateStringsArray, ...values: unknown[]): string {
    const raw = strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""),
      "",
    );
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    while (lines.length && lines[0].trim() === "") lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();

    const indents = lines.filter((l) => l.trim().length > 0)
      .map((l) => (l.match(/^(\s*)/)?.[1].length ?? 0));
    const trim = indents.length ? Math.min(...indents) : 0;
    return lines.map((l) => l.slice(trim)).join("\n");
  }
}
