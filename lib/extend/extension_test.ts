// lib/extend/extension_test.ts
import { assert, assertEquals, assertMatch } from "@std/assert";
import * as Defs from "./hook_test-fixture-defn.ts";
import {
  ExtensionHandle,
  extensionHandle,
  IssueSink,
  registerExtensionHooks,
} from "./extension.ts";

Deno.test("0) ExtensionHandle: imports module + scans hook exports (basic)", async () => {
  const issues = new IssueSink();

  const h = extensionHandle("./hook_test-fixture-impl.ts", {
    issues,
    warnIfEmpty: true,
  });

  const imported = await h.import();
  assert(imported);

  assertEquals(imported.specifier, "./hook_test-fixture-impl.ts");
  assert(imported.module);

  // fixture module exports hook impls (and no default)
  assertEquals(typeof imported.entrypoint, "undefined");
  assert(imported.hooks.length >= 1);

  // sanity check: should contain a known hook id
  assert(
    imported.hooks.some((x) => x.hookId === "spry.math.add" && x.exportName),
  );

  // no errors expected for a good import/scan
  const errs = issues.list().filter((i) => i.severity === "error");
  assertEquals(errs.length, 0);
});

Deno.test("1) ExtensionHandle: hook records carry id/name/meta + exportName", async () => {
  const issues = new IssueSink();
  const h = new ExtensionHandle("./hook_test-fixture-impl.ts", { issues });

  const imported = await h.import();
  assert(imported);

  const add = imported.hooks.find((x) => x.hookId === "spry.math.add");
  assert(add);

  assertEquals(add.exportName, "addImpl");
  assertEquals(typeof add.impl, "function");
  assert(add.meta);
  assertEquals(add.meta.kind, "hookImpl");
  assertEquals(add.meta.id, "spry.math.add");
});

Deno.test("2) ExtensionHandle: caches import result (same object reference)", async () => {
  const issues = new IssueSink();
  const h = new ExtensionHandle("./hook_test-fixture-impl.ts", { issues });

  const a = await h.import();
  const b = await h.import();

  assert(a);
  assert(b);
  assertEquals(a, b);
});

Deno.test("3) ExtensionHandle: EXT_EMPTY warning when module has no hooks and no default", async () => {
  const issues = new IssueSink();

  // No hooks, no default entrypoint
  // deno-lint-ignore require-await
  const importer = async (_specifier: string) => ({ hello: 123 });

  const h = new ExtensionHandle("in-memory-empty", {
    issues,
    importer,
    warnIfEmpty: true,
  });

  const imported = await h.import();
  assert(imported);

  assertEquals(imported.hooks.length, 0);
  assertEquals(typeof imported.entrypoint, "undefined");

  const warns = issues.list().filter((i) => i.severity === "warn");
  assert(warns.some((w) => w.code === "EXT_EMPTY"));
});

Deno.test("4) ExtensionHandle: no EXT_EMPTY when warnIfEmpty=false", async () => {
  const issues = new IssueSink();
  // deno-lint-ignore require-await
  const importer = async (_specifier: string) => ({ hello: 123 });

  const h = new ExtensionHandle("in-memory-empty", {
    issues,
    importer,
    warnIfEmpty: false,
  });

  const imported = await h.import();
  assert(imported);

  const emptyWarns = issues.list().filter((i) => i.code === "EXT_EMPTY");
  assertEquals(emptyWarns.length, 0);
});

Deno.test("5) ExtensionHandle: importer failure yields EXT_IMPORT_FAILED error and undefined result", async () => {
  const issues = new IssueSink();
  // deno-lint-ignore require-await
  const importer = async (_specifier: string) => {
    throw new Error("nope");
  };

  const h = new ExtensionHandle("in-memory-fail", { issues, importer });

  const imported = await h.import();
  assertEquals(imported, undefined);

  const errs = issues.list().filter((i) => i.severity === "error");
  assert(errs.some((e) => e.code === "EXT_IMPORT_FAILED"));

  // Deno may stringify Error as {} unless we explicitly check message/name.
  const messages = errs.map((e) => {
    const err = e.error as { message?: unknown; name?: unknown } | undefined;
    const msg = typeof err?.message === "string" ? err.message : "";
    const name = typeof err?.name === "string" ? err.name : "";
    return `${name}:${msg}:${e.message}`;
  }).join("\n");

  assertMatch(messages, /nope/);
});

Deno.test("6) Registry integration: registerExtensionHooks registers each scanned hook", async () => {
  const issues = new IssueSink();

  const h = extensionHandle("./hook_test-fixture-impl.ts", { issues });
  const imported = await h.import();
  assert(imported);

  const calls: Array<{
    hookId: string;
    exportName: string;
    specifier: string;
    hookName?: string;
  }> = [];

  const registry = {
    register: (
      hookId: string,
      _impl: unknown,
      info?: { exportName: string; specifier: string; hookName?: string },
    ) => {
      calls.push({
        hookId,
        exportName: info?.exportName ?? "",
        specifier: info?.specifier ?? "",
        hookName: info?.hookName,
      });
    },
  };

  registerExtensionHooks(imported, registry);

  assertEquals(calls.length, imported.hooks.length);
  assert(calls.some((c) => c.hookId === "spry.math.add"));
  assert(calls.every((c) => c.specifier === "./hook_test-fixture-impl.ts"));
});

Deno.test("7) Registry integration: registry throws -> EXT_REGISTER_FAILED warning (but continues)", async () => {
  const issues = new IssueSink();

  const h = extensionHandle("./hook_test-fixture-impl.ts", { issues });
  const imported = await h.import();
  assert(imported);

  let seen = 0;
  const registry = {
    register: (_hookId: string) => {
      seen++;
      throw new Error("registry boom");
    },
  };

  registerExtensionHooks(imported, registry, issues);

  // should attempt to register all hooks
  assertEquals(seen, imported.hooks.length);

  const warns = issues.list().filter((i) => i.severity === "warn");
  assert(warns.some((w) => w.code === "EXT_REGISTER_FAILED"));

  // extension.ts stores thrown error under detail.err; Error stringification may be {}.
  const messages = warns
    .filter((w) => w.code === "EXT_REGISTER_FAILED")
    .map((w) => {
      const d = w.detail as { hookId?: unknown; err?: unknown } | undefined;
      const err = d?.err as { message?: unknown; name?: unknown } | undefined;
      const msg = typeof err?.message === "string" ? err.message : "";
      const name = typeof err?.name === "string" ? err.name : "";
      return `${d?.hookId ?? ""}:${name}:${msg}:${w.message}`;
    })
    .join("\n");

  assertMatch(messages, /registry boom/);
});

Deno.test("8) End-to-end sanity: scanned hook impls actually execute via HookDefn.collect()", async () => {
  const h = extensionHandle("./hook_test-fixture-impl.ts");
  const imported = await h.import();
  assert(imported);

  // Use the imported module object directly with the hook defns
  Defs.add.issues.clear();
  const res = await Defs.add.collect(
    imported.module as Record<string, unknown>,
    {
      run: { args: [10, 20] },
    },
  );

  assertEquals(res.implementations.length, 1);
  assert(res.executed);
  assertEquals(res.executed[0].status, "fulfilled");
  assertEquals(res.executed[0].value, 30);
  assertEquals(Defs.add.issues.list().length, 0);
});
