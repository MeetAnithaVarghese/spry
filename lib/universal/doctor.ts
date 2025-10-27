/**
 * # Doctor (env checks) — Deno 2.4+ (strict)
 *
 * A tiny, declarative "doctor" utility for environment diagnostics:
 * - Pass **simple strings** for quick version checks (`"deno --version"`).
 * - Use **discriminated unions** for richer checks (`version | exists | custom | group`).
 * - Prefer **callbacks** (`onFound`, `run`, `toReport`) over rigid object keys — super extensible.
 * - Presentation is **separated**: `doctor(specs).run()` returns structured data; renderers are optional.
 *
 * ## Quick start
 *
 * ```ts
 * import { doctor } from "./doctor.ts";
 *
 * const api = doctor([
 *   "deno --version",
 *   { type: "version", cmd: { cmd: "node --version", programHint: "node" } },
 *   {
 *     type: "group", label: "Optional tools", items: [
 *       {
 *         type: "exists", cmd: "psql",
 *         onFound: async (ctx) => [
 *           { type: "version", label: "PostgreSQL", cmd: "psql --version" },
 *         ],
 *         onMissing: () => ({ kind: "suggest", message: "Install PostgreSQL (psql)"}),
 *       },
 *     ],
 *   },
 * ]);
 *
 * const result = await api.run();
 * api.render.cli(result);    // pretty console
 * // or:
 * console.log(JSON.stringify(api.render.json(result), null, 2));
 * ```
 */

import { shell as makeShell } from "./shell.ts";

/* ──────────────────────────────────────────────────────────────────────────── */
/* Public result & report types                                                */
/* ──────────────────────────────────────────────────────────────────────────── */

export type Report =
  | { kind: "ok"; message: string }
  | { kind: "warn"; message: string }
  | { kind: "suggest"; message: string };

export type RunSummary = {
  total: number;
  passed: number; // ok
  warned: number; // warn
  suggested: number; // suggest
};

export type RunItem = {
  group?: string; // logical group/category
  label: string; // human-friendly label
  capture?: {
    cmd: string;
    argv: string[];
    code: number;
    success: boolean;
    stdout: string;
    stderr: string;
    notes: string[];
    version?: string | null;
  };
  report: Report;
};

export type RunResult = {
  items: RunItem[];
  summary: RunSummary;
};

/* ──────────────────────────────────────────────────────────────────────────── */
/* Declarative specs (discriminated union)                                     */
/* ──────────────────────────────────────────────────────────────────────────── */

export type VersionCmd = string | { cmd: string; programHint?: string };

export type CheckSpec =
  // Quick path: simple version check via command string
  | string
  // Rich version check
  | {
    type: "version";
    label?: string;
    cmd: VersionCmd;
    /** Optional mapping from capture row -> final Report. */
    toReport?: (row: CaptureRow) => Report;
  }
  // Presence/existence check with optional follow-on probing
  | {
    type: "exists";
    label?: string;
    cmd: string;
    /**
     * Called when command is found. You can:
     *  - return a Report,
     *  - return nested CheckSpec[] (which will be executed),
     *  - or return void (we'll emit a default OK presence).
     */
    onFound?: (ctx: Context) => Promise<void | Report | CheckSpec[]>;
    /** Message if missing (default provided). */
    onMissing?: () => Report;
  }
  // Arbitrary custom check
  | {
    type: "custom";
    label: string;
    run: (ctx: Context) => Promise<void | Report | CheckSpec[]>;
  }
  // Logical group
  | {
    type: "group";
    label: string;
    items: Iterable<CheckSpec>;
  };

/* ──────────────────────────────────────────────────────────────────────────── */
/* Public API                                                                  */
/* ──────────────────────────────────────────────────────────────────────────── */

export type DoctorInit = {
  /** Provide a prepared shell() if you have one; we'll create one if omitted. */
  shell?: ReturnType<typeof makeShell>;
  /** If true, parse stderr when stdout is empty for version checks. Default true. */
  preferStderr?: boolean;
};

export type DoctorAPI = {
  /**
   * Execute all checks and return a structured, presentation-agnostic result.
   *
   * - Normalizes all `CheckSpec`s into `RunItem`s.
   * - Computes a `RunSummary`.
   * - Never throws for individual checks; failures are represented in `report`.
   */
  run(): Promise<RunResult>;

  /** Optional render helpers; presentation remains separate from prep. */
  render: {
    /**
     * Render a simple CLI view using ANSI colors. You can inject a custom logger
     * (defaults to global `console`).
     */
    cli: (result: RunResult, out?: { log: (...a: unknown[]) => void }) => void;
    /** Return a JSON-serializable structure (basically the RunResult). */
    json: (result: RunResult) => unknown;
  };
};

/**
 * Create a doctor API from an iterable set of `CheckSpec`s.
 *
 * @param specs Iterable of checks (strings, `version`, `exists`, `custom`, `group`).
 * @param init  Optional shell/preferStderr overrides.
 * @returns     An object with `run()` and `render` helpers.
 */
export function doctor(
  specs: Iterable<CheckSpec>,
  init?: DoctorInit,
): DoctorAPI {
  const sh = init?.shell ?? makeShell();
  const preferStderr = init?.preferStderr ?? true;

  const td = new TextDecoder();
  // deno-lint-ignore no-control-regex
  const stripAnsi = (s: string) => s.replaceAll(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const splitLines = (s: string) => s.split(/\r?\n/).map((l) => l.trim());
  const semver =
    /\bv?\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/;
  const dotted = /\b\d+(?:\.\d+){1,}\b/;
  const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // POSIX + Windows "which" without relying on shell.ts
  async function which(bin: string): Promise<string | undefined> {
    // Windows: use where.exe
    if (Deno.build.os === "windows") {
      const r = await spawnText(`where ${quote(bin)}`);
      const path = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      return r.success && path ? path : undefined;
    }
    // POSIX: use "command -v" via sh -lc (built-in)
    const r = await spawnText(
      `/usr/bin/env sh -lc "command -v ${escapeSh(bin)}"`,
    );
    const path = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return r.success && path ? path : undefined;
  }

  function quote(s: string) {
    return /[\s"]/u.test(s) ? `"${s.replaceAll('"', '\\"')}"` : s;
  }
  function escapeSh(s: string) {
    // Safe enough for a command-name lookup; wrap in single quotes and escape.
    return `'${s.replaceAll("'", "'\\''")}'`;
  }

  async function spawnText(cmd: string) {
    // Using your shell.ts abstraction:
    const r = await sh.spawnText(cmd);
    const stdout = stripAnsi(td.decode(r.stdout));
    const stderr = stripAnsi(td.decode(r.stderr));
    return { code: r.code, success: r.success, stdout, stderr };
  }

  function programFrom(cmd: string): string | undefined {
    return cmd.match(/^\s*([^\s]+)/)?.[1] ?? undefined;
  }

  function pickPrimary(stdout: string, stderr: string) {
    return stdout.trim().length > 0 ? stdout : (preferStderr ? stderr : stdout);
  }

  function parseJsonVersion(txt: string): string | null {
    const t = txt.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) return null;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      for (const k of ["version", "Version", "deno", "node", "go"]) {
        const v = obj[k];
        if (typeof v === "string" && (semver.test(v) || dotted.test(v))) {
          return (v.match(semver) ?? v.match(dotted))?.[0] ?? null;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  function extractVersion(
    program: string | undefined,
    out: string,
  ): { version: string | null; notes: string[] } {
    const notes: string[] = [];
    const txt = stripAnsi(out).trim();
    if (!txt) return { version: null, notes: ["empty output"] };

    const jsonV = parseJsonVersion(txt);
    if (jsonV) return { version: jsonV, notes: ["parsed from JSON"] };

    const ls = splitLines(txt).filter(Boolean);
    if (ls.length === 0) return { version: null, notes: ["only blank lines"] };

    for (const ln of ls) {
      const m = ln.match(semver);
      if (m) return { version: m[0], notes: ["found semver token"] };
    }

    for (const ln of ls) {
      const m = ln.match(/\bversion\b\s+(\S+)/i);
      if (m) {
        const v = m[1];
        const mm = v.match(semver) ?? v.match(dotted);
        if (mm) {
          return {
            version: mm[0],
            notes: ['matched "<something> version <x>"'],
          };
        }
      }
    }

    if (program) {
      const first = ls[0];
      const re = new RegExp(`^\\s*${escapeRx(program)}\\s+(.+)$`, "i");
      const m = first.match(re);
      if (m) {
        const v = m[1].trim();
        const mm = v.match(semver) ?? v.match(dotted);
        if (mm) {
          return {
            version: mm[0],
            notes: ['matched "<prog> <version>" on first line'],
          };
        }
        if (!/\s/.test(v)) {
          return { version: v, notes: ['took trailing token after "<prog>"'] };
        }
      }
    }

    const first = ls[0];
    if (!/\s/.test(first) && (semver.test(first) || dotted.test(first))) {
      return { version: first, notes: ["took single-token first line"] };
    }

    for (const ln of ls.slice(0, 3)) {
      const m = ln.match(dotted);
      if (m) {
        return {
          version: m[0],
          notes: ["fallback dotted match in first lines"],
        };
      }
    }

    return { version: null, notes };
  }

  async function captureVersion(cmd: VersionCmd): Promise<CaptureRow> {
    const spec = typeof cmd === "string" ? { cmd } : cmd;
    const program = spec.programHint ?? programFrom(spec.cmd);
    const r = await spawnText(spec.cmd);
    const primary = pickPrimary(r.stdout, r.stderr);
    const { version, notes } = extractVersion(program, primary);
    return {
      cmd: spec.cmd,
      argv: sh.splitArgvLine(spec.cmd),
      code: r.code,
      success: r.success,
      stdout: r.stdout,
      stderr: r.stderr,
      version,
      notes: [
        ...notes,
        r.stdout ? `stdout=len(${r.stdout.length})` : "stdout=empty",
        r.stderr ? `stderr=len(${r.stderr.length})` : "stderr=empty",
      ],
    };
  }

  async function exists(bin: string): Promise<string | undefined> {
    return await which(bin);
  }

  async function normalizeAndRun(
    input: Iterable<CheckSpec>,
    ctx: Context,
    group?: string,
  ): Promise<RunItem[]> {
    const items: RunItem[] = [];
    for (const spec of input) {
      // Simple string -> version check
      if (typeof spec === "string") {
        const row = await captureVersion(spec);
        const label = row.argv[0] ?? spec;
        const report = row.success
          ? row.version
            ? ok(`${label} ${row.version}`)
            : suggest(`${label} present but version not detected`)
          : warn(`${label} failed (code ${row.code})`);
        items.push(toRunItem(label, group, row, report));
        continue;
      }

      switch (spec.type) {
        case "version": {
          const row = await captureVersion(spec.cmd);
          const label = spec.label ??
            (row.argv[0] ??
              (typeof spec.cmd === "string" ? spec.cmd : spec.cmd.cmd));
          const report = spec.toReport
            ? spec.toReport(row)
            : row.success
            ? (row.version
              ? ok(`${label} ${row.version}`)
              : suggest(`${label} present but version not detected`))
            : warn(`${label} failed (code ${row.code})`);
          items.push(toRunItem(label, group, row, report));
          break;
        }
        case "exists": {
          const label = spec.label ?? spec.cmd;
          const bin = await exists(spec.cmd);
          if (!bin) {
            items.push(
              toRunItem(
                label,
                group,
                undefined,
                spec.onMissing?.() ?? suggest(`${spec.cmd} not found in PATH`),
              ),
            );
            break;
          }
          const out = await spec.onFound?.(ctx);
          if (Array.isArray(out)) {
            items.push(...await normalizeAndRun(out, ctx, group));
          } else if (out) {
            items.push(toRunItem(label, group, undefined, out));
          } else {
            items.push(
              toRunItem(
                label,
                group,
                undefined,
                ok(`${spec.cmd} is available`),
              ),
            );
          }
          break;
        }
        case "custom": {
          const out = await spec.run(ctx);
          if (Array.isArray(out)) {
            items.push(...await normalizeAndRun(out, ctx, group));
          } else if (out) {
            items.push(toRunItem(spec.label, group, undefined, out));
          }
          break;
        }
        case "group": {
          const gi = await normalizeAndRun(spec.items, ctx, spec.label);
          items.push(...gi);
          break;
        }
      }
    }
    return items;
  }

  async function run(): Promise<RunResult> {
    const ctx: Context = { shell: sh, captureVersion, exists, spawnText };
    const items = await normalizeAndRun(specs, ctx);
    const summary: RunSummary = {
      total: items.length,
      passed: items.filter((i) => i.report.kind === "ok").length,
      warned: items.filter((i) => i.report.kind === "warn").length,
      suggested: items.filter((i) => i.report.kind === "suggest").length,
    };
    return { items, summary };
  }

  return {
    run,
    render: {
      cli: (result, out = console) => {
        let lastGroup: string | undefined;
        for (const it of result.items) {
          if (it.group && it.group !== lastGroup) {
            out.log(dim(it.group));
            lastGroup = it.group;
          }
          const prefix = it.report.kind === "ok"
            ? "  🆗"
            : it.report.kind === "suggest"
            ? "  💡"
            : "  🚫";
          const msg = it.report.kind === "ok"
            ? green(it.report.message)
            : it.report.kind === "suggest"
            ? yellow(it.report.message)
            : red(it.report.message);
          out.log(prefix, msg);
        }
      },
      json: (result) => result, // already JSON-serializable
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* Internals                                                                   */
/* ──────────────────────────────────────────────────────────────────────────── */

type CaptureRow = {
  cmd: string;
  argv: string[];
  code: number;
  success: boolean;
  stdout: string;
  stderr: string;
  version: string | null;
  notes: string[];
};

type Context = {
  shell: ReturnType<typeof makeShell>;
  captureVersion: (cmd: VersionCmd) => Promise<CaptureRow>;
  exists: (bin: string) => Promise<string | undefined>;
  spawnText: (
    cmd: string,
  ) => Promise<
    { code: number; success: boolean; stdout: string; stderr: string }
  >;
};

const ok = (message: string): Report => ({ kind: "ok", message });
const warn = (message: string): Report => ({ kind: "warn", message });
const suggest = (message: string): Report => ({ kind: "suggest", message });

function toRunItem(
  label: string,
  group: string | undefined,
  capture: CaptureRow | undefined,
  report: Report,
): RunItem {
  return {
    group,
    label,
    capture: capture && {
      cmd: capture.cmd,
      argv: capture.argv,
      code: capture.code,
      success: capture.success,
      stdout: capture.stdout,
      stderr: capture.stderr,
      notes: capture.notes,
      version: capture.version ?? undefined,
    },
    report,
  };
}

// Minimal color helpers (no external deps)
function green(s: string) {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s: string) {
  return `\x1b[33m${s}\x1b[0m`;
}
function red(s: string) {
  return `\x1b[31m${s}\x1b[0m`;
}
function dim(s: string) {
  return `\x1b[2m${s}\x1b[0m`;
}
