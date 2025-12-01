/**
 * Small Deno utility that generates or updates a shebang line for
 * *programmable markdown* files. The shebang points to a Spry
 * entrypoint script (usually `pm-bootstrap.ts`), and the exact location
 * is determined by an environment variable or a local/remote fallback.
 *
 * This lets us run a markdown file directly:
 *
 *     ./my-notebook.md
 *
 * The first line of the file (the shebang) decides which Spry runtime
 * is used. This script helps keep that line correct and portable.
 *
 * Programmable Markdown notebooks need a *fixed* top-level shebang so
 * Linux can execute them like scripts. But the actual Spry entrypoint
 * may move between machines, repos, checkout locations, or ephemeral
 * dev environments.
 *
 * Instead of requiring developers to manually edit the shebang,
 * we generate it automatically based on:
 *
 *   - `SPRY_PMD_ENTRYPOINT` env var (local path or remote URL)
 *   - Or fallback to `./pm-bootstrap.ts` located near this module
 *
 * This keeps notebooks portable across:
 *   - different directories
 *   - `direnv`-based setups
 *   - containerized environments
 *   - team machines with different folder structures
 *
 * ## Remote vs Local Entrypoints
 *
 * 1. **Env var is set to remote (`http://` or `https://`):**
 *    → Use it **as-is** in the shebang.
 *
 * 2. **Env var is set to a local file path:**
 *    → Normalize it and convert it to a path **relative to the current working directory**,
 *      unless `useRawEnvValue: true` is passed in options.
 *
 * 3. **Env var is not set:**
 *    → Use a resolver (by default `import.meta.resolve`) on `defaultEntrypoint`.
 *       - If it resolves to a file URL → make it relative to `cwd`.
 *       - If it resolves to a remote URL → use it as-is.
 *
 * You can override the resolver via `ShebangOptions.resolver` to plug in
 * custom resolution logic (e.g., virtual module graphs, alternate roots).
 *
 * ## Basic usage
 *
 * ```ts
 * import { shebang } from "./emitShebang.ts";
 *
 * const s = shebang();
 * console.log(await s.line());
 * await s.emit("notebook.md");
 * ```
 *
 * Or from the CLI (with a Deno task):
 *
 * ```bash
 * deno task shebang notebook.md
 * ```
 *
 * ## Exports
 *
 * ```ts
 * const { line, emit, resolveEntrypointArg } = shebang(options)
 * ```
 *
 * - `line()` → returns the shebang string.
 * - `emit(filePath?)` → prints or updates a markdown file.
 * - `resolveEntrypointArg()` → returns the resolved entrypoint for debugging.
 */

import * as path from "@std/path";

export interface ShebangOptions {
  /**
   * Name of the env var to read. Defaults to "SPRY_PMD_ENTRYPOINT".
   */
  envVarName?: string;

  /**
   * Default entrypoint specifier used when the env var is not set.
   * This will be passed to the resolver (by default import.meta.resolve).
   *
   * Example: "./pm-bootstrap.ts"
   */
  entrypoint?: string;

  /**
   * Deno permissions / flags used in the shebang.
   * Defaults to ["--allow-all"].
   */
  denoFlags?: string[];

  /**
   * Default arguments passed to the entrypoint itself.
   *
   * These appear after the entrypoint in the shebang line:
   *
   *   #!/usr/bin/env -S deno run ... <entry> <entryArgs...>
   *
   * Defaults to [] (no extra args).
   */
  entrypointArgs?: string[];

  /**
   * If true, local FS values from the env var are used "as-is"
   * (absolute, relative, etc.), without converting to a path
   * relative to the base directory for the target file.
   *
   * Remote URLs (http/https) are always used as-is regardless.
   *
   * Default: false.
   */
  useRawEnvValue?: boolean;

  /**
   * Optional resolver used to resolve the defaultEntrypoint.
   *
   * Defaults to:
   *
   *   (specifier) => import.meta.resolve(specifier)
   */
  resolver?: (specifier: string) => string | Promise<string>;

  /**
   * If true (default), emit(filePaths) will also try to make the
   * file(s) executable (chmod +x) after updating the shebang so that
   * `./file.md` works directly on Unix-like systems.
   *
   * On platforms where chmod is not meaningful (e.g. Windows),
   * failures will be ignored.
   */
  makeExecutable?: boolean;

  /**
   * If true, no file modifications or chmod operations occur.
   * Instead, all actions are printed. Defaults to false.
   */
  dryRun?: boolean;
}

/**
 * Factory for shebang tools.
 *
 * Usage:
 *   const s = shebang();
 *   const line = await s.line();            // uses process cwd as base
 *   await s.emit("notebook.md");           // single file
 *   await s.emit(["a.md", "b.md"]);        // multiple files
 */
export function shebang(options: ShebangOptions = {}) {
  const {
    envVarName = "SPRY_PMD_ENTRYPOINT",
    entrypoint: defaultEntrypoint = "./pm-bootstrap.ts",
    denoFlags = ["--allow-all"],
    entrypointArgs: entryArgs = [],
    useRawEnvValue = false,
    resolver = (specifier: string): string => import.meta.resolve(specifier),
    makeExecutable = true,
    dryRun = false,
  } = options;

  async function resolveFromEnv(raw: string, baseDir: string): Promise<string> {
    const value = raw.trim();

    if (value.startsWith("http://") || value.startsWith("https://")) {
      return value;
    }

    if (useRawEnvValue) {
      return value;
    }

    const abs = path.isAbsolute(value) ? value : path.join(baseDir, value);

    let real: string;
    try {
      real = await Deno.realPath(abs);
    } catch {
      real = abs;
    }

    const rel = path.relative(baseDir, real);
    return rel || path.basename(real);
  }

  async function resolveFromDefault(baseDir: string): Promise<string> {
    const resolved = await resolver(defaultEntrypoint);

    try {
      const fsPath = path.fromFileUrl(new URL(resolved));
      const rel = path.relative(baseDir, fsPath);
      return rel || path.basename(fsPath);
    } catch {
      return resolved;
    }
  }

  async function resolveEntrypointArg(baseDir: string): Promise<string> {
    const raw = Deno.env.get(envVarName);

    if (raw && raw.trim()) {
      return await resolveFromEnv(raw, baseDir);
    }

    return await resolveFromDefault(baseDir);
  }

  async function line(baseDir?: string): Promise<string> {
    const effectiveBase = baseDir ?? Deno.cwd();
    const entry = await resolveEntrypointArg(effectiveBase);

    return [
      "#!/usr/bin/env",
      "-S",
      "deno",
      "run",
      ...denoFlags,
      entry,
      ...entryArgs,
    ].join(" ");
  }

  async function makeExecutableIfNeeded(filePath: string): Promise<void> {
    if (!makeExecutable || dryRun) return;

    try {
      const info = await Deno.lstat(filePath);
      const currentMode = info.mode;

      if (currentMode != null) {
        const newMode = currentMode | 0o111;
        if (newMode !== currentMode) {
          await Deno.chmod(filePath, newMode);
        }
      } else {
        await Deno.chmod(filePath, 0o755);
      }
    } catch {
      // ignore errors on Windows or restricted FS
    }
  }

  async function emit(filePaths?: string | string[]): Promise<void> {
    if (!filePaths) {
      const shebangLine = await line();
      console.log(shebangLine);
      return;
    }

    const files = Array.isArray(filePaths) ? filePaths : [filePaths];

    for (const filePath of files) {
      const baseDir = path.dirname(filePath);
      const shebangLine = await line(baseDir);

      const original = await Deno.readTextFile(filePath);

      const replacing = original.startsWith("#!");
      const updated = replacing
        ? original.replace(/^#![^\n]*\n/, `${shebangLine}\n`)
        : `${shebangLine}\n${original}`;

      if (dryRun) {
        console.log(`=== DRY RUN: would update file: ${filePath}`);
        console.log(
          `Action: ${replacing ? "replace shebang" : "insert shebang"}`,
        );
        console.log(`Computed shebang: ${shebangLine}`);
        if (makeExecutable) {
          console.log("Executable bit: would be set (chmod +x)");
        }
        console.log("");
        continue;
      }

      await Deno.writeTextFile(filePath, updated);
      await makeExecutableIfNeeded(filePath);
    }
  }

  return { line, emit, resolveEntrypointArg };
}
