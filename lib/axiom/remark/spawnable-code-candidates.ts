import z from "@zod/zod";
import type { Code, Root } from "types/mdast";
import type { Node } from "types/unist";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { CaptureSpec } from "../../universal/capture.ts";
import { languageRegistry, LanguageSpec } from "../../universal/code.ts";
import {
  flexibleTextSchema,
  mergeFlexibleText,
} from "../../universal/posix-pi.ts";
import { codeFrontmatter } from "../mdast/code-frontmatter.ts";
import { addIssue } from "../mdast/node-issues.ts";
import { isCodeDirectiveCandidate } from "./code-directive-candidates.ts";

export const codeSpawnablePiFlagsSchema = z.object({
  descr: z.string().optional(),
  dep: flexibleTextSchema.optional(), // collected as multiple --dep
  capture: flexibleTextSchema.optional(),
  interpolate: z.boolean().optional(),
  silent: z.boolean().optional(),
  gitignore: z.union([z.string(), z.boolean()]).optional(),
  graph: flexibleTextSchema.optional(),
  branch: flexibleTextSchema.optional(),
  injectedDep: flexibleTextSchema.optional(),

  // shortcuts
  /* capture */ C: z.string().optional(),
  /* branch/graph */ B: flexibleTextSchema.optional(),
  /* dep */ D: flexibleTextSchema.optional(),
  /* graph/branch */ G: flexibleTextSchema.optional(),
  /* interpolate */ I: z.boolean().optional(),
}).transform((raw) => {
  const depRaw = mergeFlexibleText(raw.D, raw.dep);
  const graphRaw = mergeFlexibleText(raw.G, raw.graph);
  const capture = mergeFlexibleText(raw.C, raw.capture);
  const injectedDep = mergeFlexibleText(raw.injectedDep);
  return {
    description: raw.descr,
    deps: depRaw ? typeof depRaw === "string" ? [depRaw] : depRaw : undefined,
    capture: capture.map((c) =>
      (c.startsWith("./")
        ? { nature: "relFsPath", fsPath: c, gitignore: raw.gitignore }
        : { nature: "memory", key: c }) satisfies CaptureSpec
    ),
    interpolate: raw.I ?? raw.interpolate,
    graphs: graphRaw
      ? typeof graphRaw === "string" ? [graphRaw] : graphRaw
      : undefined,
    silent: raw.silent,
    injectedDep,
  };
});

export type CodeSpawnablePiFlags = z.infer<typeof codeSpawnablePiFlagsSchema>;

export const codeSpawnableSchema = z.object({
  identity: z.string(),
  language: z.custom<LanguageSpec>().optional(),
  args: codeSpawnablePiFlagsSchema, // typed, parsed, validated
});

export type SpawnableCodeCandidate =
  & Code
  & { isSpawnableCodeCandidate: true }
  & z.infer<typeof codeSpawnableSchema>;

export function isSpawnableCodeCandidate(
  node: Node | null | undefined,
): node is SpawnableCodeCandidate {
  return node?.type === "code" && "isSpawnableCodeCandidate" in node &&
      node.isSpawnableCodeCandidate && "identity" in node && node.identity &&
      "args" in node && node.args
    ? true
    : false;
}

export const spawnableLangIds = ["shell"] as const;
export type SpawnableLangIds = typeof spawnableLangIds[number];
export const spawnableLangSpecs = spawnableLangIds.map((lid) => {
  const langSpec = languageRegistry.get(lid);
  if (!langSpec) throw new Error("this should never happen");
  return langSpec;
});

export interface SpawnableCodeCandidatesOptions {
  readonly isCandidate?: (code: Code) => boolean;
}

export const spawnableCodeCandidates: Plugin<
  [SpawnableCodeCandidatesOptions?],
  Root
> = (options) => {
  const {
    isCandidate = (code: Code) =>
      spawnableLangSpecs.find((lang) =>
          lang.id == code.lang || lang.aliases?.find((a) => a == code.lang)
        )
        ? true
        : false,
  } = options ?? {};
  return (tree) => {
    visit<Root, "code">(tree, "code", (code) => {
      if (isCodeDirectiveCandidate(code)) return;
      if (!isCandidate(code)) return;

      if (code.meta) {
        const codeFM = codeFrontmatter(code);
        if (codeFM?.langSpec && codeFM?.pi.posCount) {
          const args = z.safeParse(
            codeSpawnablePiFlagsSchema,
            codeFM.pi.flags,
          );
          if (args.success) {
            const spawnable = code as SpawnableCodeCandidate;
            spawnable.isSpawnableCodeCandidate = true;
            spawnable.identity = codeFM.pi.pos[0];
            spawnable.language = codeFM.langSpec;
            spawnable.args = args.data;

            if (!isSpawnableCodeCandidate(code)) {
              addIssue(code, {
                severity: "error",
                message: "Code should be a spawnable candidate now",
                error: new Error("Code should be a spawnable candidate now", {
                  cause: codeFM,
                }),
              });
            }
          } else {
            addIssue(code, {
              severity: "error",
              message: "Unable to parse PI flags",
              error: args.error,
            });
          }
        }
      }
    });
  };
};

export default spawnableCodeCandidates;
