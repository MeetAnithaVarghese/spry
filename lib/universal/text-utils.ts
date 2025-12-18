/**
 * Ensures content ends with a newline to prevent concatenation issues
 * when files are later appended to or processed by tools expecting proper line endings.
 * Normalizes CRLF to LF for consistent cross-platform behavior.
 *
 * @param content - The text content to normalize
 * @returns Content with CRLF normalized to LF and guaranteed trailing newline
 *
 * @example
 * ```ts
 * const text = "line1\r\nline2";
 * const normalized = ensureTrailingNewline(text);
 * // Returns: "line1\nline2\n"
 * ```
 */
export const ensureTrailingNewline = (content: string): string => {
  const normalized = content.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized : normalized + "\n";
};

/**
 * Adds double quotes to unquoted string values in YAML content while preserving
 * the original formatting of booleans, numbers, and null values.
 *
 * This function processes YAML strings and ensures that string values are properly
 * quoted with double quotes, while leaving already-quoted strings, booleans (true/false),
 * numbers, and null values unchanged.
 *
 * @param data - The YAML string to process
 * @returns The processed YAML string with quoted string values
 *
 * @example
 * ```typescript
 * const yaml = `allow_exec: true
 * port: \${env.PORT}
 * web_root: ./dev-src.auto`;
 *
 * const result = stringifyYamlWithQuotes(yaml);
 * // Output:
 * // allow_exec: true
 * // port: "${env.PORT}"
 * // web_root: "./dev-src.auto"
 * ```
 */
export function stringifyYamlWithQuotes(data: string): string {
  // Add quotes only to unquoted strings (not booleans, numbers, etc.)
  return data.replace(/^(\s*\w+:\s*)(.+)$/gm, (match, key, value) => {
    const trimmedValue = value.trim();

    // Skip if already quoted
    if (trimmedValue.startsWith('"') || trimmedValue.startsWith("'")) {
      return match;
    }

    // Skip booleans and numbers
    if (
      trimmedValue === "true" || trimmedValue === "false" ||
      trimmedValue === "null" || !isNaN(Number(trimmedValue))
    ) {
      return match;
    }

    // Add quotes to unquoted strings
    return `${key}"${trimmedValue}"`;
  });
}

/**
 * Create a reusable regex-based replacer from user-provided patterns.
 *
 * - `findRegEx` is a string representation of a regular expression pattern
 *   (without surrounding slashes).
 * - The RegExp is always created with the global (`g`) flag so that all
 *   occurrences are replaced.
 * - When `options.cache === true` (default), the RegExp instance is reused
 *   across calls for identical `(findRegEx, replaceRegEx)` pairs.
 *
 * @param findRegEx Pattern string used to build the RegExp.
 * @param replaceRegEx Replacement string (supports `$1`, `$2`, etc.).
 * @param options Optional configuration.
 * @returns A function that applies the unified RegExp replacement to input text.
 */
export function createRegexRewriter(
  findRegEx: string,
  replaceRegEx: string,
  options?: {
    /** Reuse RegExp instances for identical inputs (default: true). */
    cache?: boolean;
  },
): (input: string) => string {
  const useCache = options?.cache !== false;

  // Shared cache across all invocations
  const staticCache = (createRegexRewriter as unknown as {
    __cache?: Map<string, RegExp>;
  }).__cache ??= new Map<string, RegExp>();

  const cacheKey = `${findRegEx}␟${replaceRegEx}`;

  const regex = useCache
    ? (staticCache.get(cacheKey) ??
      (() => {
        const r = new RegExp(findRegEx, "g");
        staticCache.set(cacheKey, r);
        return r;
      })())
    : new RegExp(findRegEx, "g");

  return (input: string): string => {
    return input.replace(regex, replaceRegEx);
  };
}
