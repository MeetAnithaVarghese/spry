import type { Code, Root } from "types/mdast";
import type { Node } from "types/unist";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { languageRegistry, LanguageSpec } from "../../universal/code.ts";
import {
  instructionsFromText,
  InstructionsResult,
  textInstrCandidateParser,
} from "../../universal/posix-pi.ts";

/**
 * An asset in a code block which becomes a directive like "partial" that can be
 * included as a template or (usually) text in other code blocks.
 *
 * Example source:
 *   "```bash PARTIAL name"
 *   "```sql PARTIAL name --flag key=value"
 *
 * Parsed as:
 *   lang: "bash" or "sql"
 *   directive: "PARTIAL"
 *   identity: "name"
 *   pi: parsed flags/tokens from the code meta
 *   attrs: parsed JSON5 object from trailing "{ ... }", if present
 *
 * These nodes are emitted by {@link partialPlugin}. The plugin
 * does not interpret or attach these partials to other nodes; it
 * merely exposes them as structured values that other plugins or
 * later code can use to incorporate partials in other content.
 */
export interface CodeDirectiveCandidate<
  Identity extends string,
  Directive extends string = "PARTIAL",
> extends Code {
  isCodeDirectiveCandidate: true;
  directive: Directive;
  identity: Identity;
  langSpec?: LanguageSpec;
  instructions: InstructionsResult;
}

/**
 * Type guard for {@link CodeDirectiveCandidate} nodes.
 *
 * Safe to use with `unknown`, plain `Node`, or mdast node unions:
 *
 * ```ts
 * if (isSemanticDecorator(node)) {
 *   console.log(node.name, node.decorator, node.pi);
 * }
 * ```
 */
export function isCodeDirectiveCandidate<
  Identity extends string,
  Directive extends string,
>(
  node: Node | null | undefined,
  directive?: Directive,
): node is CodeDirectiveCandidate<Identity, Directive> {
  if (
    node?.type === "code" && "isCodeDirectiveCandidate" in node &&
    node.isCodeDirectiveCandidate && "directive" in node
  ) {
    if (directive) {
      return directive == node.directive ? true : false;
    } else {
      return true;
    }
  }
  return false;
}

export function isCodePartialCandidate<Identity extends string>(
  node: Node | null | undefined,
): node is CodeDirectiveCandidate<Identity, "PARTIAL"> {
  return isCodeDirectiveCandidate(node, "PARTIAL");
}

/**
 * Options for {@link codeDirectiveCandidates}.
 */
// deno-lint-ignore no-empty-interface
export interface CodeDirectiveOptions {
  /** for future extensions */
}

/**
 * remark plugin that converts code node types into `partial` nodes.
 *
 * Behavior:
 * - Scans `code` nodes.
 * - If meta starts with PARTIAL and an identity token it's a "partial".
 * - Augments the code object with the resulting `partial` node,
 *   preserving `position` and any existing `data`.
 *
 * This plugin does not perform any wiring or decoration itself; it is
 * intended as a primitive that other plugins can use to attach semantic
 * meaning to code blocks.
 */
export const codeDirectiveCandidates: Plugin<[CodeDirectiveOptions?], Root> =
  () => {
    const directiveParser = textInstrCandidateParser("PARTIAL");
    return (tree) => {
      visit<Root, "code">(tree, "code", (node) => {
        if (node.meta) {
          const dp = directiveParser(node.meta);
          if (dp && dp.nature === "PARTIAL") {
            // deno-lint-ignore no-explicit-any
            const partial = node as CodeDirectiveCandidate<any, "PARTIAL">;
            partial.isCodeDirectiveCandidate = true;
            partial.identity = dp.identity;
            partial.directive = dp.nature;
            if (partial.lang) {
              partial.langSpec = languageRegistry.get(partial.lang);
            }
            partial.instructions = instructionsFromText(node.meta);
          }
        }
      });
    };
  };

export default codeDirectiveCandidates;
