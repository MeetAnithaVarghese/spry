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
