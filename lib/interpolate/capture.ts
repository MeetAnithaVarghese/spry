/**
 * Capture helpers for Spry Text Interpolation and task execution.
 *
 * This module provides small, reusable factories for capturing the results of
 * operations (typically: interpolated + executed task output) either:
 *
 * - to the filesystem (relative paths), and/or
 * - into an in-memory history keyed by string.
 *
 * In the interpolation ecosystem, this is how:
 * - task stdout (or "final interpolated text") is persisted as evidence,
 * - later tasks can read from `history` via the interpolation context
 *   (e.g., `captured["some-key"]`), and
 * - outputs can be made git-ignorable when writing to disk.
 *
 * Typical flow:
 * - `captureFactory` is wired into executeTasksFactory in runbook.ts.
 * - After interpolation and execution, `capture()` is called with a Context
 *   and Operation (e.g., `{ interpResult, execResult }`).
 * - `isCapturable` decides where/if to capture.
 * - `prepareCaptured` builds a `Captured` adapter with `text()` and `json()`.
 * - `onCapture` writes to disk or memory and updates `history`.
 */

import { gitignore } from "../universal/gitignore.ts";
import { ensureTrailingNewline } from "../universal/text-utils.ts";

/**
 * Where and how a piece of captured output should be stored.
 *
 * - `"relFsPath"`:
 *   - `fsPath`: relative path within the project.
 *   - optional `gitignore`: flag or pattern to add to .gitignore.
 * - `"memory"`:
 *   - `key`: logical key under which the output is stored in `history`.
 *
 * This is intentionally small and generic so that callers can decide whether
 * captures are ephemeral (in-memory) or persistent (filesystem).
 */
export type CaptureSpec =
  | {
    readonly nature: "relFsPath";
    readonly fsPath: string;
    readonly gitignore?: boolean | string;
  }
  | {
    readonly nature: "memory";
    readonly key: string;
  };

/**
 * An adapter around captured output.
 *
 * - `text()` → returns the output as a string (e.g. stdout, interpolated text).
 * - `json()` → parses that string as JSON and returns the result.
 *
 * Callers are responsible for ensuring that `text()` returns valid JSON if
 * they intend to call `json()`.
 */
export type Captured = {
  text: () => string;
  json: () => unknown;
};

/**
 * Default capture behavior:
 *
 * - For `relFsPath`:
 *   - Write the captured text to the given file path.
 *   - Ensure the file ends with a trailing newline for readability.
 * - For `memory`:
 *   - Store the `Captured` object under `history[key]`.
 *
 * This function is used as the default `onCapture` in `captureFactory`.
 */
export async function typicalOnCapture(
  cs: CaptureSpec,
  cap: Captured,
  history: Record<string, Captured>,
) {
  if (cs.nature === "relFsPath") {
    await Deno.writeTextFile(cs.fsPath, ensureTrailingNewline(cap.text()));
  } else {
    history[cs.key] = cap;
  }
}

/**
 * Capture behavior with gitignore support:
 *
 * - For `relFsPath`:
 *   - Write the captured text to the file (with trailing newline).
 *   - If `gitignore` is truthy:
 *     - Derive a path suitable for .gitignore.
 *     - Call `gitignore()` to add an ignore rule (with optional comment).
 * - For `memory`:
 *   - Store the `Captured` object under `history[key]`.
 *
 * This is typically used in pipelines where captured artifacts should not
 * be checked into version control.
 */
export async function gitignorableOnCapture(
  cs: CaptureSpec,
  cap: Captured,
  history: Record<string, Captured>,
) {
  if (cs.nature === "relFsPath") {
    await Deno.writeTextFile(cs.fsPath, ensureTrailingNewline(cap.text()));

    const { gitignore: ignore } = cs;
    if (ignore) {
      // We expect fsPath to be something like "./path/to/file".
      // For .gitignore we usually want a repo-relative path.
      const gi = cs.fsPath.slice("./".length);
      if (typeof ignore === "string") {
        await gitignore(gi, ignore);
      } else {
        await gitignore(gi);
      }
    }
  } else {
    history[cs.key] = cap;
  }
}

/**
 * Factory for async capture pipelines.
 *
 * This is the main entry point used by the runbook executor. It:
 *
 * - Holds an internal `history` object mapping string keys → `Captured`.
 * - Exposes a `capture(ctx, op)` function that:
 *   - Asks `isCapturable(ctx, op)` for zero or more CaptureSpecs.
 *   - If any are returned:
 *     - Builds a `Captured` wrapper via `prepareCaptured(op, ctx)`.
 *     - Calls `onCapture(spec, cap, history)` for each spec.
 *
 * @template Context
 *   An opaque type describing "what is being operated on" (e.g. task).
 * @template Operation
 *   An opaque type describing the operation result (e.g. { interpResult, execResult }).
 *
 * @param opts.isCapturable
 *   Decide whether and where to capture, given a context and an operation.
 *   Return `false` to skip, or an array of CaptureSpec to perform captures.
 * @param opts.prepareCaptured
 *   Convert the operation + context into a `Captured` adapter.
 * @param opts.onCapture
 *   Optional hook to actually perform capture (defaults to `typicalOnCapture`).
 */
export function captureFactory<Context, Operation>(
  opts: {
    readonly isCapturable: (
      ctx: Context,
      op: Operation,
    ) => false | CaptureSpec[];
    readonly prepareCaptured: (op: Operation, ctx: Context) => Captured;
    readonly onCapture?: (
      cs: CaptureSpec,
      cap: Captured,
      history: Record<string, Captured>,
    ) => void | Promise<void>;
  },
) {
  const history = {} as Record<string, Captured>;
  const {
    isCapturable,
    prepareCaptured,
    onCapture = typicalOnCapture,
  } = opts;

  /**
   * Compute capture specs for `(ctx, op)` and, if any, perform captures.
   *
   * In typical use:
   * - `ctx` is a task or similar unit of work.
   * - `op` carries results like `interpResult` and/or `execResult`.
   */
  const capture = async (ctx: Context, op: Operation) => {
    const specs = isCapturable(ctx, op);
    if (specs) {
      const cap = prepareCaptured(op, ctx);
      for (const cs of specs) {
        await onCapture(cs, cap, history);
      }
    }
  };

  return {
    isCapturable,
    onCapture,
    history,
    capture,
    prepareCaptured,
  };
}

/**
 * Simpler, synchronous capture factory.
 *
 * This variant is useful when:
 * - There is no asynchronous IO involved in capture, or
 * - You want to keep tests or small utilities fully synchronous.
 *
 * It behaves similarly to `captureFactory`, but:
 * - `isCapturable(ctx)` returns a single CaptureSpec or `false`.
 * - `prepareCapture(ctx)` builds the `Captured` adapter.
 * - `onCapture` is synchronous.
 */
export function captureFactorySync<Context>(
  opts: {
    readonly isCapturable: (ctx: Context) => false | CaptureSpec;
    readonly prepareCapture: (ctx: Context) => Captured;
    readonly onCapture?: (
      cs: CaptureSpec,
      cap: Captured,
      history: Record<string, Captured>,
    ) => void;
  },
) {
  const history = {} as Record<string, Captured>;
  const {
    isCapturable,
    prepareCapture: prepareCaptured,
    onCapture = typicalOnCapture as (
      cs: CaptureSpec,
      cap: Captured,
      history: Record<string, Captured>,
    ) => void,
  } = opts;

  /**
   * Compute capture spec for `ctx` and, if present, perform capture.
   */
  const capture = (ctx: Context) => {
    const cs = isCapturable(ctx);
    if (cs) {
      const cap = prepareCaptured(ctx);
      onCapture(cs, cap, history);
    }
  };

  return {
    isCapturable,
    onCapture,
    history,
    capture,
    prepareCaptured,
  };
}
