import z from "@zod/zod";
import { Code, Node, Root } from "types/mdast";
import { VFile } from "vfile";
import { callableDefn } from "../../extend/extension.ts";

// TODO: add Zod validation for Code, Root, VFile, etc.

export const mdastRootHook = callableDefn(
  "spry.axiom.mdast.vfileTree",
  { input: [z.custom<Root>(), z.custom<VFile>()], output: z.void() },
);

export const mdastNodeHook = callableDefn(
  "spry.axiom.mdast.node",
  {
    input: [z.custom<Node>(), z.custom<Root>(), z.custom<VFile>()],
    output: z.void(),
  },
);

export const mdastCodeHook = callableDefn(
  "spry.axiom.mdast.code",
  {
    input: [z.custom<Code>(), z.custom<Root>(), z.custom<VFile>()],
    output: z.void(),
  },
);
