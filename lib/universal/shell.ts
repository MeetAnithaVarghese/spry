import {
  bold,
  cyan,
  dim,
  gray,
  green,
  magenta,
  red,
  yellow,
} from "jsr:@std/fmt@1/colors";
import { eventBus } from "./event-bus.ts";

/** Events the shell factory can emit */
export type ShellBusEvents = {
  "spawn:start": {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    hasStdin: boolean;
  };
  "spawn:done": {
    cmd: string;
    args: string[];
    code: number;
    success: boolean;
    stdout: Uint8Array;
    stderr: Uint8Array;
    durationMs: number;
  };
  "spawn:error": {
    cmd: string;
    args: string[];
    error: unknown;
  };

  "task:line:start": { index: number; line: string };
  "task:line:done": {
    index: number;
    line: string;
    code: number;
    success: boolean;
    stdout: Uint8Array;
    stderr: Uint8Array;
    durationMs: number;
  };

  "shebang:tempfile": { path: string };
  "shebang:cleanup": { path: string; ok: boolean; error?: unknown };

  "auto:mode": { mode: "shebang" | "eval" };
};

type ShellKey = keyof ShellBusEvents & string;
type MaybeArgs<K extends ShellKey> = ShellBusEvents[K] extends void ? []
  : [ShellBusEvents[K]];

export function shell(init?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  tmpDir?: string;
  /** Optional, strongly-typed event bus for shell lifecycle */
  bus?: ReturnType<typeof eventBus<ShellBusEvents>>;
}) {
  const cwd = init?.cwd;
  const env = init?.env;
  const tmpDir = init?.tmpDir;
  const bus = init?.bus;

  type RunResult = {
    code: number;
    success: boolean;
    stdout: Uint8Array;
    stderr: Uint8Array;
  };

  const emit = <K extends ShellKey>(type: K, ...detail: MaybeArgs<K>): void => {
    if (!bus) return;
    // Reinterpret `bus.emit` with a compatible generic signature and call it.
    (bus.emit as <T extends ShellKey>(t: T, ...d: MaybeArgs<T>) => boolean)(
      type,
      ...detail,
    );
  };

  function cleanEnv(
    e?: Record<string, string | undefined>,
  ): Record<string, string> | undefined {
    if (!e) return undefined;
    const pairs: [string, string][] = [];
    for (const [k, v] of Object.entries(e)) {
      if (v !== undefined) pairs.push([k, v]);
    }
    return pairs.length ? Object.fromEntries(pairs) : {};
  }

  const run = async (
    cmd: string,
    args: readonly string[],
    stdin?: Uint8Array,
  ): Promise<RunResult> => {
    const argsArr = [...args];
    emit("spawn:start", {
      cmd,
      args: argsArr,
      cwd,
      env: cleanEnv(env),
      hasStdin: !!(stdin && stdin.length),
    });

    const started = performance.now();
    const command = new Deno.Command(cmd, {
      args: argsArr,
      cwd,
      env: cleanEnv(env),
      stdin: stdin && stdin.length ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    });

    try {
      if (stdin && stdin.length) {
        const child = command.spawn();
        try {
          const writer = child.stdin!.getWriter();
          try {
            await writer.write(stdin);
          } finally {
            await writer.close();
          }
          const { code, success, stdout, stderr } = await child.output();
          const durationMs = performance.now() - started;
          emit("spawn:done", {
            cmd,
            args: argsArr,
            code,
            success,
            stdout,
            stderr,
            durationMs,
          });
          return { code, success, stdout, stderr };
        } finally {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        }
      } else {
        const { code, success, stdout, stderr } = await command.output();
        const durationMs = performance.now() - started;
        emit("spawn:done", {
          cmd,
          args: argsArr,
          code,
          success,
          stdout,
          stderr,
          durationMs,
        });
        return { code, success, stdout, stderr };
      }
    } catch (error) {
      emit("spawn:error", { cmd, args: argsArr, error });
      throw error;
    }
  };

  // simple quoted argv splitter for spawnText()
  const splitArgvLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quote: '"' | "'" | null = null;
    let esc = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (esc) {
        cur += ch;
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        else cur += ch;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch as '"' | "'";
        continue;
      }
      if (/\s/.test(ch)) {
        if (cur) {
          out.push(cur);
          cur = "";
        }
        continue;
      }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };

  const spawnArgv = (argv: readonly string[], stdin?: Uint8Array) => {
    if (!argv.length) {
      return Promise.resolve<RunResult>({
        code: 0,
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
    }
    const [cmd, ...args] = argv;
    return run(cmd, args, stdin);
  };

  const spawnText = (line: string, stdin?: Uint8Array) =>
    spawnArgv(splitArgvLine(line), stdin);

  const denoTaskEval = async (program: string) => {
    const lines = program.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const results: Array<
      {
        index: number;
        line: string;
      } & RunResult
    > = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      emit("task:line:start", { index: i, line });
      const started = performance.now();
      const r = await spawnArgv(["deno", "task", "--eval", line]);
      const durationMs = performance.now() - started;
      emit("task:line:done", {
        index: i,
        line,
        code: r.code,
        success: r.success,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs,
      });
      results.push({ index: i, line, ...r });
    }
    return results;
  };

  const spawnShebang = async (script: string, stdin?: Uint8Array) => {
    const file = await Deno.makeTempFile({
      dir: tmpDir,
      prefix: "shell-",
    });
    emit("shebang:tempfile", { path: file });
    try {
      await Deno.writeTextFile(file, script);
      await Deno.chmod(file, 0o755);
      const res = await spawnArgv([file], stdin);
      return res;
    } finally {
      try {
        await Deno.remove(file);
        emit("shebang:cleanup", { path: file, ok: true });
      } catch (error) {
        emit("shebang:cleanup", { path: file, ok: false, error });
      }
    }
  };

  const auto = (source: string, stdin?: Uint8Array) => {
    const first = source.split(/\r?\n/, 1)[0] ?? "";
    if (first.startsWith("#!")) {
      emit("auto:mode", { mode: "shebang" });
      return spawnShebang(source, stdin);
    } else {
      emit("auto:mode", { mode: "eval" });
      return denoTaskEval(source);
    }
  };

  return {
    spawnText,
    spawnArgv,
    spawnShebang,
    denoTaskEval,
    auto,
    splitArgvLine,
  };
}

/**
 * Create a verbose info bus for Shell events.
 *
 * - style: "rich" → emoji + ANSI colors
 * - style: "plain" → no emoji, no colors
 *
 * Pass the returned `bus` into `shell({ bus })`.
 */
export function verboseInfoShellEventBus(init: { style: "plain" | "rich" }) {
  const fancy = init.style === "rich";
  const bus = eventBus<ShellBusEvents>();

  const E = {
    rocket: "🚀",
    check: "✅",
    cross: "❌",
    boom: "💥",
    play: "▶️",
    gear: "⚙️",
    page: "📄",
    broom: "🧹",
    timer: "⏱️",
    box: "🧰",
  } as const;

  const c = {
    tag: (s: string) => (fancy ? bold(magenta(s)) : s),
    cmd: (s: string) => (fancy ? bold(cyan(s)) : s),
    ok: (s: string) => (fancy ? green(s) : s),
    warn: (s: string) => (fancy ? yellow(s) : s),
    err: (s: string) => (fancy ? red(s) : s),
    path: (s: string) => (fancy ? bold(s) : s),
    faint: (s: string) => (fancy ? dim(s) : s),
    gray: (s: string) => (fancy ? gray(s) : s),
  };

  const em = {
    start: (s: string) => (fancy ? `${E.rocket} ${s}` : s),
    done: (
      s: string,
      ok: boolean,
    ) => (fancy ? `${ok ? E.check : E.cross} ${s}` : s),
    error: (s: string) => (fancy ? `${E.boom} ${s}` : s),
    play: (s: string) => (fancy ? `${E.play} ${s}` : s),
    gear: (s: string) => (fancy ? `${E.gear} ${s}` : s),
    page: (s: string) => (fancy ? `${E.page} ${s}` : s),
    broom: (s: string) => (fancy ? `${E.broom} ${s}` : s),
    timer: (ms?: number) =>
      ms === undefined
        ? ""
        : fancy
        ? ` ${E.timer} ${Math.round(ms)}ms`
        : ` ${Math.round(ms)}ms`,
  };

  const fmtArgs = (args: readonly string[]) =>
    args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");

  // ---- listeners ----
  bus.on("spawn:start", ({ cmd, args, cwd, hasStdin }) => {
    const line =
      `${c.tag("[spawn]")} ${em.start(c.cmd(cmd))} ${fmtArgs(args)} ` +
      c.faint(
        [
          cwd ? `cwd=${cwd}` : "",
          hasStdin ? "stdin=piped" : "stdin=null",
        ].filter(Boolean).join(" "),
      );
    console.info(line);
  });

  bus.on("spawn:done", ({ cmd, args, code, success, durationMs }) => {
    const line =
      `${c.tag("[spawn]")} ${em.done(c.cmd(cmd), success)} ${fmtArgs(args)} ` +
      (success ? c.ok(`code=${code}`) : c.err(`code=${code}`)) +
      em.timer(durationMs);
    console.info(line);
  });

  bus.on("spawn:error", ({ cmd, args, error }) => {
    const line =
      `${c.tag("[spawn]")} ${em.error(c.cmd(cmd))} ${fmtArgs(args)} ` +
      c.err(String(error instanceof Error ? error.message : error));
    console.error(line);
  });

  bus.on("task:line:start", ({ index, line }) => {
    const msg = `${c.tag("[task]")} ${em.play(`L${index}`)} ${c.gray(line)}`;
    console.info(msg);
  });

  bus.on("task:line:done", ({ index, line, code, success, durationMs }) => {
    const msg = `${c.tag("[task]")} ${em.done(`L${index}`, success)} ` +
      (success ? c.ok(`code=${code}`) : c.err(`code=${code}`)) +
      ` ${c.gray(line)}` +
      em.timer(durationMs);
    console.info(msg);
  });

  bus.on("shebang:tempfile", ({ path }) => {
    console.info(`${c.tag("[shebang]")} ${em.page("temp")} ${c.path(path)}`);
  });

  bus.on("shebang:cleanup", ({ path, ok, error }) => {
    const head = `${c.tag("[shebang]")} ${em.broom("cleanup")} ${
      c.path(path)
    } `;
    console[ok ? "info" : "error"](
      head + (ok ? c.ok("ok") : c.err(String(error ?? "error"))),
    );
  });

  bus.on("auto:mode", ({ mode }) => {
    const txt = mode === "shebang" ? "shebang" : "eval-lines";
    const msg = `${c.tag("[auto]")} ${em.gear(txt)}`;
    console.info(msg);
  });

  return bus;
}

/**
 * Create an error-focused event bus for Shell events.
 *
 * Only logs errors — ignores successful runs.
 * Displays concise diagnostics with decoded `stderr` output
 * when available. Style can be `"plain"` or `"rich"` for
 * emoji + ANSI-colored output.
 *
 * Pass the returned `bus` into `shell({ bus })`.
 *
 * Example:
 * ```ts
 * const bus = errorOnlyShellEventBus({ style: "rich" });
 * const sh = shell({ bus });
 * await sh.spawnText("deno run missing.ts");
 * ```
 */
export function errorOnlyShellEventBus(init: { style: "plain" | "rich" }) {
  const fancy = init.style === "rich";
  const bus = eventBus<ShellBusEvents>();

  const E = {
    cross: "❌",
    boom: "💥",
    warn: "⚠️",
    page: "📄",
    broom: "🧹",
  } as const;

  const c = {
    tag: (s: string) => (fancy ? bold(magenta(s)) : s),
    cmd: (s: string) => (fancy ? bold(cyan(s)) : s),
    err: (s: string) => (fancy ? red(s) : s),
    path: (s: string) => (fancy ? bold(s) : s),
    faint: (s: string) => (fancy ? dim(s) : s),
  };

  const em = {
    fail: (s: string) => (fancy ? `${E.cross} ${s}` : s),
    boom: (s: string) => (fancy ? `${E.boom} ${s}` : s),
    warn: (s: string) => (fancy ? `${E.warn} ${s}` : s),
    page: (s: string) => (fancy ? `${E.page} ${s}` : s),
    broom: (s: string) => (fancy ? `${E.broom} ${s}` : s),
  };

  function decode(u8: Uint8Array): string {
    return new TextDecoder().decode(u8).trim();
  }

  // ---- listeners ----
  bus.on("spawn:error", ({ cmd, args, error }) => {
    console.error(
      `${c.tag("[spawn]")} ${em.boom(c.cmd(cmd))} ${args.join(" ")} → ${
        c.err(String(error instanceof Error ? error.message : error))
      }`,
    );
  });

  bus.on("spawn:done", ({ cmd, args, code, success, stderr }) => {
    if (!success) {
      console.error(
        `${c.tag("[spawn]")} ${em.fail(c.cmd(cmd))} ${args.join(" ")} ${
          c.err(`(code=${code})`)
        }`,
      );
      const msg = decode(stderr);
      if (msg) console.error(c.err(msg));
    }
  });

  bus.on("task:line:done", ({ index, line, code, success, stderr }) => {
    if (!success) {
      console.error(
        `${c.tag("[task]")} ${em.fail(`L${index}`)} ${
          c.err(`(code=${code})`)
        } ${c.faint(line)}`,
      );
      const msg = decode(stderr);
      if (msg) console.error(c.err(msg));
    }
  });

  bus.on("shebang:cleanup", ({ path, ok, error }) => {
    if (!ok) {
      console.error(
        `${c.tag("[shebang]")} ${em.broom("cleanup")} ${c.path(path)} → ${
          em.warn(
            String(error ?? "unknown error"),
          )
        }`,
      );
    }
  });

  return bus;
}
