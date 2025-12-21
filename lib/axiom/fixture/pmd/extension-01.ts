import { hook } from "../../../extend/hook.ts";
import { mdastRootHook } from "../../io/hooks.ts";
import { ExtensionInit } from "../../mod.ts";

export let entryPointInit: ExtensionInit | undefined;
export let treeHandlerHookCalls = 0;

export const treeHandlerHook = hook(
  mdastRootHook,
  (_tree, _vfile) => treeHandlerHookCalls++,
);

// entryPoint is optional but useful if "global initialization" required
// deno-lint-ignore require-await
export default async function entryPoint(init: ExtensionInit) {
  entryPointInit = init;
}
