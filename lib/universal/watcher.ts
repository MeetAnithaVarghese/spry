import { debounce } from "jsr:@std/async@1/debounce";
import { eventBus } from "./event-bus.ts";

const isLocalPath = (p: string) => !/^([a-z]+:)?\/\//i.test(p);

export type SidecarOpts = {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  shutdownSignal?: Deno.Signal; // default: "SIGTERM"
  shutdownTimeoutMs?: number; // default: 1500
  name?: string;
};

export type WatcherEvents = {
  "watch:ready": { files: string[] };
  "watch:event": Deno.FsEvent;
  "run:begin": { runIndex: number };
  "run:success": { runIndex: number };
  "run:error": { runIndex: number; error: unknown };
  "sidecar:start": { index: number; spec: SidecarOpts };
  "sidecar:stop": { index: number; spec: SidecarOpts };
  "sidecar:stopped": { index: number; spec: SidecarOpts };
  "disposed": void;
};

export type WatcherOpts = {
  debounceMs?: number;
  recursive?: boolean;
  sidecars?: SidecarOpts[];
  bus?: ReturnType<typeof eventBus<WatcherEvents>>;
  onEvent?: (ev: Deno.FsEvent) => void;
  onError?: (err: unknown) => void;
};

type Runner = {
  (arg?: boolean | { watch?: boolean; signal?: AbortSignal }): Promise<void>;
  dispose(): Promise<void>;
};

export function watcher(
  files: readonly string[],
  cb: (runIndex: number, watch: boolean) => void | Promise<void>,
  {
    debounceMs = 100,
    recursive = false,
    sidecars = [],
    bus,
    onEvent,
    onError,
  }: WatcherOpts = {},
): Runner {
  const watchables = files.filter(isLocalPath);

  let disposed = false;
  let running = false; // full cycle in progress
  let pending = false; // rerun requested while running
  let fsWatcher: Deno.FsWatcher | undefined;
  let procs: (Deno.ChildProcess | undefined)[] = [];

  // Run counter: first run (any reason) is 0. In watch mode, subsequent cycles are 1,2,3,...
  let nextRunIndex = 0;

  // deno-lint-ignore require-await
  const startSidecars = async () => {
    procs = [];
    for (let i = 0; i < sidecars.length; i++) {
      const spec = sidecars[i]!;
      bus?.emit("sidecar:start", { index: i, spec });
      const cmd = new Deno.Command(spec.cmd[0], {
        args: spec.cmd.slice(1),
        cwd: spec.cwd,
        env: spec.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      procs.push(cmd.spawn());
    }
  };

  const stopSidecars = async () => {
    if (!procs.length) return;
    const stops = procs.map(async (child, i) => {
      if (!child) return;
      const spec = sidecars[i]!;
      bus?.emit("sidecar:stop", { index: i, spec });

      const sig = spec.shutdownSignal ?? "SIGTERM";
      const timeout = spec.shutdownTimeoutMs ?? 1500;

      try {
        child.kill(sig);
      } catch { /* ignore */ }

      const done = child.status;
      const timer = new Promise<void>((resolve) =>
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
            // deno-lint-ignore no-empty
          } catch {}
          resolve();
        }, timeout)
      );
      await Promise.race([done.then(() => undefined), timer]);
      bus?.emit("sidecar:stopped", { index: i, spec });
    });
    await Promise.all(stops);
    procs = [];
  };

  // One atomic cycle: stop sidecars → cb(runIndex, watch) → (re)start sidecars
  const fullRun = async () => {
    if (disposed) return;
    running = true;

    const runIndex = nextRunIndex;
    const inWatch = Boolean(fsWatcher);

    bus?.emit("run:begin", { runIndex });
    try {
      await stopSidecars();
      await cb(runIndex, inWatch);
      // Start sidecars only after successful callback
      if (inWatch && sidecars.length && !disposed) {
        await startSidecars();
      }
      bus?.emit("run:success", { runIndex });
      // If watching, increment for next cycle; in one-shot, it stays at 0 (unused).
      if (inWatch) nextRunIndex = runIndex + 1;
    } catch (error) {
      onError?.(error);
      bus?.emit("run:error", { runIndex, error });
      // Even on error, advance the index in watch mode (so errors are counted in the sequence).
      if (inWatch) nextRunIndex = runIndex + 1;
    } finally {
      running = false;
      if (pending && !disposed) {
        pending = false;
        queueMicrotask(() => runOnce());
      }
    }
  };

  const runOnce = async () => {
    if (disposed) return;
    if (running) {
      pending = true;
      return;
    }
    await fullRun();
  };

  const debouncedRun = debounce(runOnce, debounceMs);

  const dispose = async () => {
    disposed = true;
    try {
      fsWatcher?.close();
      // deno-lint-ignore no-empty
    } catch {}
    fsWatcher = undefined;
    await stopSidecars();
    bus?.emit("disposed");
  };

  const runner: Runner = async (arg) => {
    if (disposed) return;

    const watch = typeof arg === "boolean"
      ? arg
      : (typeof arg === "object" && arg ? arg.watch ?? false : false);
    const signal = typeof arg === "object" && arg ? arg.signal : undefined;

    // One-shot: call cb with (0, false)
    if (!watch || watchables.length === 0) {
      await cb(0, false);
      return;
    }

    // Watch mode: initialize watcher and run first cycle as (0, true)
    fsWatcher = Deno.watchFs(watchables, { recursive });
    bus?.emit("watch:ready", { files: watchables });

    // First full cycle (0, true): do NOT start sidecars before, start only after cb
    await fullRun();

    try {
      for await (const ev of fsWatcher) {
        if (disposed) break;
        onEvent?.(ev);
        bus?.emit("watch:event", ev);

        if (
          ev.kind === "create" || ev.kind === "modify" ||
          ev.kind === "remove" || ev.kind === "any"
        ) {
          debouncedRun();
        }
        if (signal?.aborted) break;
      }
    } finally {
      await dispose();
    }
  };

  runner.dispose = dispose;
  return runner;
}
