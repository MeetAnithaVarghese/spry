import z from "@zod/zod";
import { Root } from "types/mdast";
import { VFile } from "vfile";
import { hookDefn } from "../../extend/hook.ts";

export const mdastRootHook = hookDefn(
  "spry.axiom.io.vfileTree",
  { input: [z.custom<Root>(), z.custom<VFile>()], output: z.void() },
);
