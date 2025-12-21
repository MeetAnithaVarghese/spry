import { hook } from "./hook.ts";
import {
  add,
  explode,
  minimalOnLoaded,
  onLoadedFull,
  onLoadedWithBus,
  onLoadedWithIssues,
} from "./hook_test-fixture-defn.ts";

/**
 * Implementers supply *no* types and *no* generics.
 * Everything is inferred from the hook definitions.
 */

export const addImpl = hook(add, (a, b) => a + b);

export const minimalOnLoadedImpl = hook(minimalOnLoaded, (ctx) => {
  void ctx.file;
});

export const onLoadedWithIssuesImpl = hook(onLoadedWithIssues, (ctx) => {
  ctx.issues?.info("EXT_ONLOADED_ISSUES", `Loaded ${ctx.file}`);
});

export const onLoadedWithBusImpl = hook(onLoadedWithBus, (ctx) => {
  ctx.issues?.info("EXT_ONLOADED_BUS", `Loaded ${ctx.file}`);

  ctx.bus?.emit("note", { message: `hello:${ctx.file}` });

  // ✅ detail is now contextually typed (not any)
  const off = ctx.bus?.on("warn", (detail) => {
    ctx.issues?.warn("EXT_WARN_SEEN", detail.code, { detail });
  });

  off?.();
});

export const onLoadedFullImpl = hook(onLoadedFull, (ctx) => {
  ctx.issues?.info("EXT_ONLOADED_FULL", `Loaded ${ctx.file}`);

  ctx.bus?.emit("note", { message: `full:${ctx.file}` });

  // ✅ detail is typed and opts.signal is typed
  ctx.bus?.on(
    "warn",
    (detail) => {
      ctx.issues?.warn("EXT_WARN_SIGNAL", detail.code, { detail });
    },
    { signal: ctx.signal },
  );

  void ctx.text;
});

export const explodeImpl = hook(explode, (_msg) => {
  throw new Error("boom");
});
