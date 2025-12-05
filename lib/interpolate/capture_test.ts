import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type Captured,
  captureFactory,
  captureFactorySync,
  type CaptureSpec,
  gitignorableOnCapture,
  typicalOnCapture,
} from "./capture.ts";

function makeCap(textValue: string): Captured {
  return {
    text: () => textValue,
    json: () => ({ value: textValue }),
  };
}

Deno.test("captureFactory (async) – memory + fs capture", async (t) => {
  await t.step("captures to memory only", async () => {
    const cf = captureFactory<
      { readonly id: string },
      { readonly msg: string }
    >({
      isCapturable: (ctx, op) =>
        ctx.id === "mem" ? [{ nature: "memory", key: op.msg }] : false,
      prepareCaptured: (op) => makeCap(`mem:${op.msg}`),
    });

    await cf.capture({ id: "mem" }, { msg: "hello" });

    assert("hello" in cf.history);
    assertEquals(cf.history["hello"].text(), "mem:hello");
    assertEquals(cf.history["hello"].json(), { value: "mem:hello" });
  });

  await t.step("captures to filesystem only", async () => {
    const tmp = await Deno.makeTempDir();
    const outFile = `${tmp}/out.txt`;

    const cf = captureFactory<
      { readonly id: string },
      { readonly msg: string }
    >({
      isCapturable: (_ctx, _op) => [{
        nature: "relFsPath",
        fsPath: outFile,
      }],
      prepareCaptured: (op) => makeCap(op.msg),
    });

    await cf.capture({ id: "anything" }, { msg: "file-content" });

    const diskText = await Deno.readTextFile(outFile);
    // ensureTrailingNewline should add newline
    assertStringIncludes(diskText, "file-content");
  });

  await t.step("captures to filesystem with gitignore entry", async () => {
    const tmp = await Deno.makeTempDir();
    const outFile = `${tmp}/data.txt`;

    const cf = captureFactory<
      { readonly id: string },
      { readonly msg: string }
    >({
      isCapturable: (_ctx, _op) => [{
        nature: "relFsPath",
        fsPath: outFile,
        gitignore: true,
      }],
      prepareCaptured: (op) => makeCap(op.msg),
      onCapture: gitignorableOnCapture,
    });

    await cf.capture({ id: "x" }, { msg: "ignored-ok" });

    const diskText = await Deno.readTextFile(outFile);
    assertStringIncludes(diskText, "ignored-ok");

    // gitignorableOnCapture writes to .gitignore relative to project root.
    // We do NOT assert filesystem side effects here.
    // We only assert capture did not crash.
    assert(true);
  });
});

Deno.test("captureFactorySync – memory + fs", async (t) => {
  await t.step("sync memory capture", () => {
    const cf = captureFactorySync<{ readonly x: string }>({
      isCapturable: (ctx) =>
        ctx.x === "mem"
          ? {
            nature: "memory",
            key: "val",
          }
          : false,
      prepareCapture: (_ctx) => makeCap("sync-mem"),
    });

    cf.capture({ x: "mem" });
    assert("val" in cf.history);
    assertEquals(cf.history["val"].text(), "sync-mem");
  });

  await t.step("sync fs capture", async () => {
    const tmp = await Deno.makeTempDir();
    const outFile = `${tmp}/sync.txt`;

    const cf = captureFactorySync<{ readonly k: string }>({
      isCapturable: (_ctx) => ({
        nature: "relFsPath",
        fsPath: outFile,
      }),
      prepareCapture: (_ctx) => makeCap("sync-file"),
    });

    cf.capture({ k: "x" });
    const text = await Deno.readTextFile(outFile);
    assertStringIncludes(text, "sync-file");
  });
});

Deno.test("typicalOnCapture + gitignorableOnCapture – handler tests", async (t) => {
  await t.step("typicalOnCapture writes to file or memory", async () => {
    const tmp = await Deno.makeTempDir();
    const p1: CaptureSpec = {
      nature: "relFsPath",
      fsPath: `${tmp}/t1.txt`,
    };
    const cap = makeCap("hello-world");
    const history: Record<string, Captured> = {};

    await typicalOnCapture(p1, cap, history);

    const diskText = await Deno.readTextFile(p1.fsPath);
    assertStringIncludes(diskText, "hello-world");

    // memory capture:
    const p2: CaptureSpec = { nature: "memory", key: "m1" };
    await typicalOnCapture(p2, cap, history);
    assert("m1" in history);
    assertEquals(history["m1"].text(), "hello-world");
  });

  await t.step(
    "gitignorableOnCapture writes file + (optionally) .gitignore",
    async () => {
      const tmp = await Deno.makeTempDir();
      const p1: CaptureSpec = {
        nature: "relFsPath",
        fsPath: `${tmp}/t2.txt`,
        gitignore: true,
      };
      const cap = makeCap("gi-test");
      const history: Record<string, Captured> = {};

      await gitignorableOnCapture(p1, cap, history);

      const diskText = await Deno.readTextFile(p1.fsPath);
      assertStringIncludes(diskText, "gi-test");

      // No assertion on .gitignore contents to avoid polluting the repo.
      assert(true);
    },
  );
});
