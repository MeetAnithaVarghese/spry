/**
 * Directive parsing and auto-identity generation for Markdown-based DSLs.
 *
 * This module exports a `directivesCandidate()` factory that produces a
 * configurable directive recognizer. A *directive* is a line that begins with
 * an ALL-UPPERCASE **NATURE** token (e.g., `PARTIAL`, `TASK`, `NOTE`) followed
 * by an optional **IDENTITY** token.
 *
 * ## Core Behavior
 *
 * - A directive **must begin with a NATURE token**:
 *     `[A-Z][A-Z0-9_-]*`
 *
 * - The **IDENTITY token is required** in the final parsed result, but it may
 *   be:
 *     1. **Explicitly supplied** by the user, or
 *     2. **Automatically generated** by an internal counter.
 *
 * - Whether a given NATURE allows auto-generation of identity is determined
 *   via `perNatureRequirement`:
 *
 *     - `"both"` → user must provide identity explicitly
 *     - `"auto"` (default) → identity may be omitted and will be generated
 *
 * - Auto-generated identities use per-nature or default padding, and can be
 *   optionally prefixed with the nature (e.g., `"PARTIAL-0001"`).
 *
 * ## Counter Model
 *
 * Every NATURE has its own independent counter, starting at `0`. When identity
 * generation is permitted:
 *
 *   - With `identityWithNaturePrefix = false` → `"0000"`, `"0001"`, …
 *   - With `identityWithNaturePrefix = true`  → `"PARTIAL-0000"`, `"PARTIAL-0001"`, …
 *
 * Padding width is controlled by:
 *
 *   - `defaultPad` (global)
 *   - `perNaturePad` (per-NATURE override)
 *
 * Counters persist for the lifetime of the factory instance and can be cleared
 * via `resetCounters()`.
 *
 * ## Example
 *
 * ```ts
 * const dc = directivesCandidate({
 *   perNatureRequirement: {
 *     PARTIAL: "both", // must supply identity
 *     TASK:    "auto", // identity optional
 *   },
 *   defaultPad: 3,
 * });
 *
 * dc.isTextInstructionsCandidate("PARTIAL header");
 * // { nature: "PARTIAL", identity: "header" }
 *
 * dc.isTextInstructionsCandidate("TASK");
 * // { nature: "TASK", identity: "000" }
 * ```
 *
 * ## API Summary
 *
 * The factory returns:
 *
 * - `isTextInstructionsCandidate(text)`
 *     → `{ nature, identity }` or `false`
 *
 * - `counter(name)`
 *     → returns or creates a per-nature counter
 *
 * - `counters`
 *     → internal counter map (for diagnostics)
 *
 * - `resetCounters()`
 *     → clears all counters
 *
 * - `textInstrCandidateRegEx`
 *     → the regex used for detection (NATURE + optional IDENTITY)
 *
 * ## Use Cases
 *
 * - Markdown-driven build/playbook systems
 * - Lightweight DSLs for transformations (Spry playbooks, Semgrep-like rules)
 * - AST decoration pipelines (mdast/unist)
 * - Instruction-based content assembly or extraction
 *
 * The module is deliberately small and deterministic, avoiding full parsing
 * complexity while providing enough structure to support robust line-level
 * directive interpretation.
 */
export interface DirectivesParserOptions {
  /**
   * Default padding width for generated numeric identities.
   * Default: 4 => "0000", "0001", ...
   */
  defaultPad?: number;

  /**
   * Optional per-nature padding. Example:
   *   { PARTIAL: 3, TASK: 5 }
   */
  perNaturePad?: Record<string, number>;

  /**
   * If true, auto-generated identities will include the
   * nature as prefix, e.g. "PARTIAL-0001" instead of "0001".
   * Default: false.
   */
  identityWithNaturePrefix?: boolean;

  /**
   * Per-NATURE rules about whether identity may be auto-generated:
   *
   * - "both" => nature and identity must both be explicitly supplied
   *             by the user. If identity is missing, the line is rejected.
   * - "auto" => identity may be omitted and will be defaulted via a counter.
   *
   * If a nature is not present in this map, it behaves like "auto".
   */
  perNatureRequirement?: Record<string, "both" | "auto">;
}

// -------------------------------------------------------------
// Regex: NATURE is required, IDENTITY is optional.
//
// Examples that match:
//   `PARTIAL foo`
//   `TASK`
//   `  NOTE   myNote`
//   `PARTIAL header`
//   `PARTIAL "Main header"`
//   `NOTE "Section 1: Intro"`
//   `TASK foo_bar-123`
//
// Not allowed unless quoted:
//    `PARTIAL main header`     // invalid (space without quotes)
//    `NOTE foo,bar`            // invalid unless "foo,bar"
// -------------------------------------------------------------
export const onlyDirectiveCandidateRegEx = /^[A-Z][A-Z0-9_-]*$/;
export const directiveAndNatureCandidateRegEx =
  /^\s*(?<nature>[A-Z][A-Z0-9_-]*)(?:\s+(?<identity>"[^"]+"|[A-Za-z_][\.A-Za-z0-9_-]*))?\b/;

export function directivesParser(options: DirectivesParserOptions = {}) {
  const {
    defaultPad = 4,
    perNaturePad = {},
    identityWithNaturePrefix = false,
    perNatureRequirement = {},
  } = options;

  // -------------------------------------------------------------
  // Counters
  // -------------------------------------------------------------
  const counters: Record<
    string,
    {
      identifier: string;
      incr: () => number;
      nextPadded: () => string;
      nextText: (text?: string) => string;
    }
  > = {};

  function counter<Identifier extends string>(
    identifier: Identifier,
    padValue = defaultPad,
  ) {
    if (identifier in counters) return counters[identifier];

    let value = -1;
    const incr = () => ++value;
    const nextPadded = () => String(incr()).padStart(padValue, "0");
    const nextText = (text = `${identifier}-`) =>
      `${text}${String(incr()).padStart(padValue, "0")}`;

    const c = { identifier, incr, nextPadded, nextText };
    counters[identifier] = c;
    return c;
  }

  function resetCounters() {
    for (const key of Object.keys(counters)) {
      delete counters[key];
    }
  }

  // -------------------------------------------------------------
  // Main instruction parser
  // Always returns either:
  //   - false
  //   - { nature: string; identity: string }
  // -------------------------------------------------------------

  function isDirective(
    text: string,
  ): false | { nature: string; identity: string } {
    const match = text.match(directiveAndNatureCandidateRegEx);
    if (!match?.groups) return false;

    let { nature, identity } = match.groups as {
      nature?: string;
      identity?: string;
    };

    if (!nature) return false; // should not happen given the regex

    const requirement = perNatureRequirement[nature] ?? "auto";

    // If identity is missing:
    // - For "both": reject (must be supplied by user)
    // - For "auto": auto-generate via counter
    if (!identity || identity.trim().length === 0) {
      if (requirement === "both") {
        return false;
      }

      const pad = perNaturePad[nature] ?? defaultPad;
      const c = counter(nature, pad);
      identity = identityWithNaturePrefix ? c.nextText() : c.nextPadded();
    }

    return { nature, identity };
  }

  return {
    directiveCandidateRegEx: directiveAndNatureCandidateRegEx,
    isDirective,
    counter,
    counters,
    resetCounters,
  };
}
