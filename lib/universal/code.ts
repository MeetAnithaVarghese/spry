/**
 * content/code.ts
 * General-purpose "code content" DX:
 *  - Language registry (comment syntax, extensions, shebangs)
 *  - Code-specific governance type
 *  - CodeFileContent wrapper + openCodeFile()
 *  - DX helpers (builders, detection utils)
 *
 * Focus-agnostic: usable for comments, linting, formatting, etc.
 */

import { z } from "@zod/zod";

/* -------------------------------------------------------------------------------------------------
 * Language registry (reusable beyond comments)
 * -----------------------------------------------------------------------------------------------*/

/** Schema for block comment delimiters */
export const commentBlockSchema = z.object({
  open: z.string(),
  close: z.string(),
  nested: z.boolean().optional(),
});

/** Schema for comment styles (line + block) */
export const commentStyleSchema = z.object({
  line: z.array(z.string()).readonly(),
  block: z.array(commentBlockSchema).readonly(),
});

/** Schema for language specifications */
export const languageSpecSchema = z.object({
  id: z.string(),
  aliases: z.array(z.string()).readonly().optional(),
  extensions: z.array(z.string()).readonly().optional(),
  shebangs: z.array(z.string()).readonly().optional(),
  mime: z.string().optional(),
  /** Minimal info most tooling needs; comments are used by the comments module */
  comment: commentStyleSchema,
});

export type CommentStyle = z.infer<typeof commentStyleSchema>;
export type LanguageSpec = z.infer<typeof languageSpecSchema>;

export const languageRegistry = new Map<string, LanguageSpec>();
export const languageExtnIndex = new Map<string, LanguageSpec>();

export function registerLanguage(spec: LanguageSpec): void {
  languageRegistry.set(spec.id, spec);
  for (const ext of spec.extensions ?? []) {
    languageExtnIndex.set(ext.toLowerCase(), spec);
  }
  for (const alias of spec.aliases ?? []) languageRegistry.set(alias, spec);
}

export function getLanguageByIdOrAlias(
  idOrAlias: string,
): LanguageSpec | undefined {
  return languageRegistry.get(idOrAlias);
}

export function ensureLanguageByIdOrAlias(
  idOrAlias: string,
): LanguageSpec {
  const result = languageRegistry.get(idOrAlias);
  if (!result) throw new Error(`Language ID ${idOrAlias} not found`);
  return result;
}

export function detectLanguageByShebang(
  firstLine: string,
): LanguageSpec | undefined {
  if (!firstLine.startsWith("#!")) return undefined;
  const rest = firstLine.slice(2).trim();
  for (const spec of languageRegistry.values()) {
    for (const s of spec.shebangs ?? []) {
      if (rest.includes(s)) return spec;
    }
  }
  return undefined;
}

/** Preload a solid default set */
(function preloadLanguages() {
  // TS/JS (+ jsonc compatibility)
  registerLanguage({
    id: "typescript",
    aliases: ["ts", "javascript", "js", "tsx", "jsx"],
    extensions: [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".jsonc",
      ".json5",
    ],
    shebangs: ["node", "deno"],
    mime: "text/typescript",
    comment: {
      line: ["//"],
      block: [{ open: "/*", close: "*/", nested: false }],
    },
  });
  // JSON (allow //, /* */ for JSONC tooling)
  registerLanguage({
    id: "json",
    extensions: [".json"],
    comment: {
      line: ["//"],
      block: [{ open: "/*", close: "*/", nested: false }],
    },
  });
  // JSON (allow //, /* */ for JSONC tooling)
  registerLanguage({
    id: "json5",
    extensions: [".json5"],
    comment: {
      line: ["//"],
      block: [{ open: "/*", close: "*/", nested: false }],
    },
  });
  registerLanguage({
    id: "python",
    aliases: ["py"],
    extensions: [".py"],
    shebangs: ["python", "python3", "python2"],
    comment: { line: ["#"], block: [] },
  });
  registerLanguage({
    id: "shell",
    aliases: ["bash", "sh", "zsh"],
    extensions: [".sh", ".bash", ".zsh"],
    shebangs: ["bash", "sh", "zsh"],
    comment: { line: ["#"], block: [] },
  });
  registerLanguage({
    id: "go",
    extensions: [".go"],
    comment: {
      line: ["//"],
      block: [{ open: "/*", close: "*/", nested: false }],
    },
  });
  registerLanguage({
    id: "rust",
    aliases: ["rs"],
    extensions: [".rs"],
    comment: {
      line: ["//"],
      block: [{ open: "/*", close: "*/", nested: true }],
    },
  });
  registerLanguage({
    id: "java",
    extensions: [".java"],
    comment: {
      line: ["//"],
      block: [{ open: "/*", close: "*/", nested: false }],
    },
  });
  registerLanguage({
    id: "kotlin",
    aliases: ["kt"],
    extensions: [".kt", ".kts"],
    comment: {
      line: ["//"],
      block: [{ open: "/*", close: "*/", nested: false }],
    },
  });
  registerLanguage({
    id: "c",
    extensions: [".c", ".h"],
    comment: {
      line: ["//"],
      block: [{ open: "/*", close: "*/", nested: false }],
    },
  });
  registerLanguage({
    id: "cpp",
    aliases: ["c++", "cc", "hpp"],
    extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hxx"],
    comment: {
      line: ["//"],
      block: [{ open: "/*", close: "*/", nested: false }],
    },
  });
  registerLanguage({
    id: "html",
    extensions: [".html", ".htm"],
    comment: {
      line: [],
      block: [{ open: "<!--", close: "-->", nested: false }],
    },
  });
  registerLanguage({
    id: "xml",
    extensions: [".xml"],
    comment: {
      line: [],
      block: [{ open: "<!--", close: "-->", nested: false }],
    },
  });
  registerLanguage({
    id: "css",
    extensions: [".css"],
    comment: {
      line: [],
      block: [{ open: "/*", close: "*/", nested: false }],
    },
  });
  registerLanguage({
    id: "scss",
    extensions: [".scss", ".sass"],
    comment: {
      line: ["//"],
      block: [{ open: "/*", close: "*/", nested: false }],
    },
  });
  registerLanguage({
    id: "sql",
    extensions: [".sql"],
    comment: {
      line: ["--"],
      block: [{ open: "/*", close: "*/", nested: false }],
    },
  });
  registerLanguage({
    id: "yaml",
    extensions: [".yaml", ".yml"],
    comment: { line: ["#"], block: [] },
  });
  registerLanguage({
    id: "toml",
    extensions: [".toml"],
    comment: { line: ["#"], block: [] },
  });
  registerLanguage({
    id: "ini",
    extensions: [".ini", ".cfg"],
    comment: { line: [";", "#"], block: [] },
  });
  registerLanguage({
    id: "lua",
    extensions: [".lua"],
    comment: {
      line: ["--"],
      block: [{ open: "--[[", close: "]]", nested: true }],
    },
  });
  registerLanguage({
    id: "r",
    extensions: [".r", ".R"],
    comment: { line: ["#"], block: [] },
  });
  registerLanguage({
    id: "envrc",
    extensions: [".envrc"],
    comment: { line: ["#"], block: [] },
  });
  registerLanguage({
    id: "env",
    extensions: [".env"],
    comment: { line: ["#"], block: [] },
  });
})();
