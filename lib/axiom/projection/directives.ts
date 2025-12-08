import { visit } from "unist-util-visit";
import {
  PartialCollection,
  partialContent,
} from "../../interpolate/partial.ts";
import { MarkdownEncountered } from "../io/mod.ts";
import {
  CodeDirectiveCandidate,
  isCodeDirectiveCandidate,
} from "../remark/code-directive-candidates.ts";

/**
 * A directive is a code cell that controls behavior instead of being executed.
 *
 * Example: a fenced block like
 *
 * ```md
 * ```sql PARTIAL footer
 * -- footer here
 * ```
 *
 * is parsed as a `CodeDirectiveCandidate`, and we wrap it as a `Directive`
 * with an added `provenance` (where it came from in which Markdown file).
 */
export type Directive =
  & Omit<CodeDirectiveCandidate<string, string>, "isCodeDirectiveCandidate">
  & { readonly provenance: MarkdownEncountered };

export function collectDirectives<
  FragmentLocals extends Record<string, unknown> = Record<string, unknown>,
>(
  provenance: MarkdownEncountered,
  globalDirectives: Directive[],
  partials: PartialCollection<FragmentLocals>,
) {
  const localDirectives: Directive[] = [];
  visit(provenance.mdastRoot, "code", (code) => {
    if (isCodeDirectiveCandidate(code)) {
      const { isCodeDirectiveCandidate: _, ...rest } = code;
      localDirectives.push({ ...rest, provenance });
    }
  });
  globalDirectives.push(...localDirectives);

  for (const ld of localDirectives) {
    if (ld.directive === "PARTIAL") {
      const { pi: { flags }, attrs } = ld.instructions;

      const hasFlag = (k: string) =>
        k in flags && flags[k] !== false && flags[k] !== undefined;

      // `--inject` can be:
      //   - absent        → no injection
      //   - string        → single glob
      //   - string[]      → multiple globs
      const injectGlobs = flags.inject === undefined
        ? []
        : Array.isArray(flags.inject)
        ? (flags.inject as string[])
        : [String(flags.inject)];

      // Only build a spec when attrs are present
      const schemaSpec = attrs && Object.keys(attrs).length > 0
        ? attrs
        : undefined;

      // Always pass schemaSpec + strictArgs; inject is optional.
      partials.register(
        partialContent<FragmentLocals, Directive>(
          ld.identity,
          ld.value,
          ld,
          {
            schemaSpec,
            strictArgs: true,
            inject: injectGlobs.length
              ? {
                globs: injectGlobs,
                prepend: hasFlag("prepend"),
                append: hasFlag("append"),
              }
              : undefined,
          },
        ),
      );
    }
  }
}
