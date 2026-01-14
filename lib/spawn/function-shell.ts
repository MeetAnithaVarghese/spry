// lib/spawn/function-shell.ts
import { ensureLanguageByIdOrAlias } from "../universal/code.ts";
import { parsedHttpRequests } from "../universal/rfc9110-http.ts";
import {
  createLanguageEngine,
  type EngineTagged,
  type LanguageInitBase,
  toStdinBytes,
} from "./code-shell.ts";

export type FunctionInitBase = LanguageInitBase & EngineTagged;

/**
 * Mirrors input to stdout and always succeeds.
 * Intended for simple in-process engines like env/envrc.
 */
function createMirroredInputEngine<const LangId extends string>(
  langId: LangId,
) {
  const language = ensureLanguageByIdOrAlias(langId);

  return createLanguageEngine<typeof language, FunctionInitBase>({
    language,
    defaultBins: [`<function:${langId}>`],
    capabilities: { stdin: true, file: true, eval: true },
    preferredMode: "stdin",
    planInvocation: ({ bin }) => ({ argv: [bin], mode: "stdin" }),

    execute: ({ input, mode }) => {
      const stdout = toStdinBytes(input);
      return {
        code: 0,
        success: true,
        stdout,
        stderr: new Uint8Array(),
        argv: [`function:${langId}:${mode}`],
      };
    },
  });
}

/**
 * Parses RFC 9110-ish HTTP request text and executes the first request via fetch.
 */
function createHttpEngine<const LangId extends string>(langId: LangId) {
  const language = ensureLanguageByIdOrAlias(langId);

  return createLanguageEngine<typeof language, FunctionInitBase>({
    language,
    defaultBins: [`<function:${langId}>`],
    capabilities: { stdin: true, file: true, eval: true },
    preferredMode: "stdin",
    planInvocation: ({ bin }) => ({ argv: [bin], mode: "stdin" }),

    execute: async ({ input, mode }) => {
      try {
        const text = input.kind === "text"
          ? input.text
          : new TextDecoder().decode(input.bytes);

        const parsed = parsedHttpRequests(text);
        const first = parsed.requests[0];

        if (!first) {
          const msg =
            "httpEngine: no requests found (expected RFC 9110-ish request text)\n";
          return {
            code: 2,
            success: false,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode(msg),
            argv: [`function:${langId}:${mode}`],
          };
        }

        const res = await first.fetch({ fetch });

        const lines: string[] = [];
        lines.push(`HTTP ${res.status} ${res.statusText}`.trimEnd());
        for (const [k, v] of res.headers) lines.push(`${k}: ${v}`);
        lines.push("");

        const bodyText = await res.text();
        if (bodyText) lines.push(bodyText);

        const out = lines.join("\n").replace(/\n?$/, "\n");
        return {
          code: res.ok ? 0 : 1,
          success: res.ok,
          stdout: new TextEncoder().encode(out),
          stderr: new Uint8Array(),
          argv: [`function:${langId}:${mode}`],
        };
      } catch (err) {
        const msg = `httpEngine: failed\n${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }\n`;
        return {
          code: 2,
          success: false,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode(msg),
          argv: [`function:${langId}:${mode}`],
        };
      }
    },
  });
}

// These correspond to LanguageSpec ids in lib/universal/code.ts
export const envEngine = createMirroredInputEngine("env");
export const envrcEngine = createMirroredInputEngine("envrc");
export const httpEngine = createHttpEngine("http");

export function envInit(
  init: Omit<FunctionInitBase, "engineId"> = {},
): FunctionInitBase {
  return { ...init, engineId: envEngine.id };
}

export function envrcInit(
  init: Omit<FunctionInitBase, "engineId"> = {},
): FunctionInitBase {
  return { ...init, engineId: envrcEngine.id };
}

export function httpInit(
  init: Omit<FunctionInitBase, "engineId"> = {},
): FunctionInitBase {
  return { ...init, engineId: httpEngine.id };
}
