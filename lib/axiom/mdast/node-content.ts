// -----------------------------------------------------------------------------
// Node content helpers
// -----------------------------------------------------------------------------

import { Heading, Node, Text } from "types/mdast";
import { NodeDecorator } from "../remark/node-decorator.ts";

// Helper: extract heading text for assertions
export function headingText(node: Node): string {
  const heading = node as Heading;
  if (heading.type !== "heading") return "";
  const parts: string[] = [];
  for (const child of heading.children ?? []) {
    const textNode = child as Text;
    if (textNode.type === "text" && typeof textNode.value === "string") {
      parts.push(textNode.value);
      break;
    }
  }
  return parts.join("");
}

// Helper: flatten visible text from a node (ignores formatting)
export function nodePlainText(node: Node): string {
  if (node.type === "root") return "root";

  const parts: string[] = [];

  function walk(n: Node) {
    if (
      (n as { value?: unknown }).value &&
      (n as { type?: string }).type === "text"
    ) {
      // deno-lint-ignore no-explicit-any
      parts.push(String((n as any).value));
    }
    const anyN = n as { children?: Node[] };
    if (Array.isArray(anyN.children)) {
      for (const c of anyN.children) walk(c);
    }
  }

  walk(node);
  return parts.join("");
}

export function truncateNodeLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

export function typicalNodeLabel(node: Node): string {
  const type = (node as { type?: string }).type ?? "unknown";

  // Headings: "heading:#2 My title"
  if (type === "heading") {
    const heading = node as Heading;
    const text = headingText(heading) || "(heading)";
    const depthPart = typeof heading.depth === "number"
      ? `#${heading.depth} `
      : "";
    return `heading: ${depthPart}${text}`;
  }

  // Paragraphs: "paragraph:First few words…"
  if (type === "paragraph") {
    const text = nodePlainText(node) || "(paragraph)";
    return `paragraph: ${truncateNodeLabel(text, 80)}`;
  }

  // Code blocks: "code:yaml @id mdast-io-project"
  if (type === "code") {
    const c = node as Node & { lang?: string | null; value?: string };
    const lang = c.lang ? c.lang.toLowerCase() : "";
    const firstLine = (c.value ?? "").split(/\r?\n/, 1)[0] ?? "";
    const langPart = lang ? `${lang} ` : "";
    const textPart = firstLine ? truncateNodeLabel(firstLine, 60) : "(code)";
    return `code: ${langPart}${textPart}`;
  }

  // Lists and list items: "list", "- First list item…"
  if (type === "listItem" || type === "list") {
    const text = nodePlainText(node);
    if (text) {
      const prefix = type === "listItem" ? "- " : "list: ";
      return `${prefix}${truncateNodeLabel(text, 80)}`;
    }
    return type;
  }

  if (type === "decorator") {
    const d = node as NodeDecorator;
    return `decorator: ${d.kind}${d.decorator}`;
  }

  // Fallback: type + truncated visible text, never JSON
  const text = nodePlainText(node);
  if (text) {
    return `${type}:${truncateNodeLabel(text, 80)}`;
  }
  return type;
}
