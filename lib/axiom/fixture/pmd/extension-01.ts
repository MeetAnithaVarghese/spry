import { callable } from "../../../extend/extension.ts";
import { mdastRootHook } from "../../mdast/hooks.ts";

export let treeHandlerHookCalls = 0;

export const treeHandlerHook = callable(
  mdastRootHook,
  (_tree, _vfile) => {
    treeHandlerHookCalls++;
  },
);
