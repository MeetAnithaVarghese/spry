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
import { indent } from "./tmpl-literal-aide.ts";

type WithBaggage<Baggage, T> = T & { baggage?: Baggage };

export type ShellBusEvents<Baggage = unknown> = {
  "spawn:start": WithBaggage<Baggage, {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    hasStdin: boolean;
  }>;
  "spawn:done": WithBaggage<Baggage, {
    cmd: string;
    args: string[];
    code: number;
    success: boolean;
    stdout: Uint8Array;
    stderr: Uint8Array;
    durationMs: number;
  }>;
  "spawn:error": WithBaggage<Baggage, {
    cmd: string;
    args: string[];
    error: unknown;
  }>;

  "task:line:start": WithBaggage<Baggage, { index: number; line: string }>;
  "task:line:done": WithBaggage<Baggage, {
    index: number;
    line: string;
    code: number;
    success: boolean;
    stdout: Uint8Array;
    stderr: Uint8Array;
    durationMs: number;
  }>;

  "shebang:tempfile": WithBaggage<Baggage, { path: string; script: string }>;
  "shebang:cleanup": WithBaggage<
    Baggage,
    { path: string; ok: boolean; error?: unknown }
  >;

  "auto:mode": WithBaggage<Baggage, { mode: "shebang" | "eval" }>;
};

export function shell<Baggage = unknown>(init?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  tmpDir?: string;
  /** Optional, strongly-typed event bus for shell lifecycle */
  bus?: ReturnType<typeof eventBus<ShellBusEvents<Baggage>>>;
}) {
  const cwd = init?.cwd;
  const env = init?.env;
  const tmpDir = init?.tmpDir;
  const bus = init?.bus;

  type Events = ShellBusEvents<Baggage>;
  type ShellKey = keyof Events & string;
  type MaybeArgs<K extends ShellKey> = Events[K] extends void ? []
    : [Events[K]];

  type RunResult = {
    code: number;
    success: boolean;
    stdout: Uint8Array;
    stderr: Uint8Array;
    baggage?: Baggage;
  };

  const emit = <K extends ShellKey>(type: K, ...detail: MaybeArgs<K>): void => {
    if (!bus) return;
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
    baggage?: Baggage,
  ): Promise<RunResult> => {
    const argsArr = [...args];
    emit("spawn:start", {
      cmd,
      args: argsArr,
      cwd,
      env: cleanEnv(env),
      hasStdin: !!(stdin && stdin.length),
      baggage,
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
            baggage,
          });
          return { code, success, stdout, stderr, baggage };
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
          baggage,
        });
        return { code, success, stdout, stderr, baggage };
      }
    } catch (error) {
      emit("spawn:error", { cmd, args: argsArr, error, baggage });
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

  const spawnArgv = (
    argv: readonly string[],
    stdin?: Uint8Array,
    baggage?: Baggage,
  ) => {
    if (!argv.length) {
      return Promise.resolve<RunResult>({
        code: 0,
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        baggage,
      });
    }
    const [cmd, ...args] = argv;
    return run(cmd, args, stdin, baggage);
  };

  const spawnText = (line: string, stdin?: Uint8Array, baggage?: Baggage) =>
    spawnArgv(splitArgvLine(line), stdin, baggage);

  const denoTaskEval = async (
    program: string,
    baggage?: Baggage,
  ) => {
    const lines = program.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const results: Array<
      {
        index: number;
        line: string;
      } & RunResult
    > = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      emit("task:line:start", { index: i, line, baggage });
      const started = performance.now();
      const r = await spawnArgv(
        ["deno", "task", "--eval", line],
        undefined,
        baggage,
      );
      const durationMs = performance.now() - started;
      emit("task:line:done", {
        index: i,
        line,
        code: r.code,
        success: r.success,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs,
        baggage,
      });
      results.push({ index: i, line, ...r });
    }
    return results;
  };

  const spawnShebang = async (
    script: string,
    stdin?: Uint8Array,
    baggage?: Baggage,
  ) => {
    const file = await Deno.makeTempFile({
      dir: tmpDir,
      prefix: "shell-",
    });
    emit("shebang:tempfile", { path: file, script, baggage });
    try {
      await Deno.writeTextFile(file, script);
      await Deno.chmod(file, 0o755);
      const res = await spawnArgv([file], stdin, baggage);
      return res;
    } finally {
      try {
        await Deno.remove(file);
        emit("shebang:cleanup", { path: file, ok: true, baggage });
      } catch (error) {
        emit("shebang:cleanup", { path: file, ok: false, error, baggage });
      }
    }
  };

  const auto = <B extends Baggage = Baggage>(
    source: string,
    stdin?: Uint8Array,
    baggage?: B,
  ) => {
    const first = source.split(/\r?\n/, 1)[0] ?? "";
    if (first.startsWith("#!")) {
      emit("auto:mode", { mode: "shebang", baggage });
      return spawnShebang(source, stdin, baggage);
    } else {
      emit("auto:mode", { mode: "eval", baggage });
      return denoTaskEval(source, baggage);
    }
  };

  const strategy = (source: string) => {
    const linesOfCode = source.split(/\r?\n/, 1);
    const first = linesOfCode[0] ?? "";
    if (first.startsWith("#!")) {
      return { engine: "shebang" as const, label: first, linesOfCode };
    } else {
      return {
        engine: "deno-task" as const,
        label: `${linesOfCode.length} Deno task${
          linesOfCode.length > 1 ? "s" : ""
        }`,
        linesOfCode,
      };
    }
  };

  return {
    spawnText,
    spawnArgv,
    spawnShebang,
    denoTaskEval,
    auto,
    splitArgvLine,
    strategy,
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
export function verboseInfoShellEventBus<Baggage = unknown>(
  init: {
    readonly style: "plain" | "rich";
    readonly emitStdOut?: (
      event: ShellBusEvents<Baggage>["spawn:done"],
    ) => boolean;
  },
) {
  const fancy = init.style === "rich";
  const bus = eventBus<ShellBusEvents<Baggage>>();
  const te = new TextDecoder();
  const { emitStdOut } = init;

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

  bus.on(
    "spawn:done",
    (ev) => {
      const { cmd, args, code, success, durationMs, stdout, stderr } = ev;
      if (!emitStdOut || emitStdOut(ev)) {
        console.info(
          `${c.tag("[spawn]")} ${em.done(c.cmd(cmd), success)} ${
            fmtArgs(args)
          } ` +
            (success ? c.ok(`code=${code}`) : c.err(`code=${code}`)) +
            em.timer(durationMs),
        );
      }
      if (stdout.length > 0) {
        console.info(dim(indent(te.decode(stdout))));
      }
      if (stderr.length > 0) {
        console.info(red(indent(te.decode(stderr))));
      }
    },
  );

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

  bus.on(
    "task:line:done",
    ({ index, line, code, success, durationMs }) => {
      console.info(
        `${c.tag("[task]")} ${em.done(`L${index}`, success)} ` +
          (success ? c.ok(`code=${code}`) : c.err(`code=${code}`)) +
          ` ${c.gray(line)}` +
          em.timer(durationMs),
      );
      // we don't emit stdout and stderr because spawn:done will already
      // have been called for deno tasks
    },
  );

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
export function errorOnlyShellEventBus<Baggage = unknown>(
  init: {
    readonly style: "plain" | "rich";
    readonly "shebang:tempfile"?: boolean;
    readonly emitStdOut?: (
      event: ShellBusEvents<Baggage>["spawn:done"],
    ) => boolean;
  },
) {
  const fancy = init.style === "rich";
  const bus = eventBus<ShellBusEvents<Baggage>>();
  const { emitStdOut } = init;

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

  if (init["shebang:tempfile"]) {
    bus.on("shebang:tempfile", ({ path, script }) => {
      console.log({ where: "shebang:tempfile", path, script });
    });
  }

  bus.on("spawn:error", ({ cmd, args, error }) => {
    console.error(
      `${c.tag("[spawn]")} ${em.boom(c.cmd(cmd))} ${args.join(" ")} → ${
        c.err(String(error instanceof Error ? error.message : error))
      }`,
    );
  });

  bus.on(
    "spawn:done",
    (ev) => {
      const { cmd, args, code, success, stderr, stdout } = ev;
      if (!emitStdOut || emitStdOut(ev)) {
        console.info(decode(stdout));
      }
      if (!success) {
        console.error(
          `${c.tag("[spawn]")} ${em.fail(c.cmd(cmd))} ${args.join(" ")} ${
            c.err(`(code=${code})`)
          }`,
        );
        const msg = decode(stderr);
        if (msg) console.error(c.err(msg));
      }
    },
  );

  bus.on("task:line:done", ({ index, line, code, success }) => {
    // we don't emit stdout and stderr because spawn:done will already
    // have been called for deno tasks
    if (!success) {
      console.error(
        `${c.tag("[task]")} ${em.fail(`L${index}`)} ${
          c.err(`(code=${code})`)
        } ${c.faint(line)}`,
      );
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
