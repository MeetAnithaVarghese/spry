import { z } from "jsr:@zod/zod@4";
import {
  fbPartialCandidate,
  fbPartialsCollection,
  mdFencedBlockPartialSchema,
  notebooks,
  Playbook,
  PlaybookCodeCell,
  playbooks,
  pseudoCellsGenerator,
} from "../markdown/notebook/mod.ts";
import {
  AnnotationCatalog,
  extractAnnotationsFromText,
} from "../universal/code-comments.ts";
import {
  languageRegistry,
  LanguageSpec,
  languageSpecSchema,
} from "../universal/code.ts";
import { Task } from "../universal/task.ts";
import { CodeCell, Issue, Source } from "../markdown/governedmd.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type TasksProvenance = string;

export function annotationsFactory<Anns extends Record<string, unknown>>(
  init: {
    language: LanguageSpec;
    prefix?: string;
    defaults?: Partial<Anns>;
    schema?: z.ZodType;
  },
) {
  function transform(
    catalog: Awaited<
      ReturnType<typeof extractAnnotationsFromText<unknown>>
    >,
    opts?: { prefix?: string; defaults?: Partial<Anns> },
  ) {
    const { prefix, defaults } = opts ?? init;
    const annotations = prefix
      ? (catalog.items
        .filter((it) => it.kind === "tag" && it.key?.startsWith(prefix))
        .map((it) =>
          [it.key!.slice(prefix.length), it.value ?? it.raw] as const
        ))
      : catalog.items.map((it) => [it.key!, it.value ?? it.raw] as const);
    const found = annotations.length;
    if (found == 0) {
      if (!defaults) return undefined;
      if (Object.keys(defaults).length == 0) return undefined;
    }
    return { ...defaults, ...Object.fromEntries(annotations) } as Anns;
  }

  async function catalog(source: string, language?: LanguageSpec) {
    return await extractAnnotationsFromText<Anns>(
      source,
      language ?? init?.language,
      {
        tags: { multi: true, valueMode: "json" },
        kv: false,
        yaml: false,
        json: false,
      },
    );
  }

  return { ...init, catalog, transform };
}

export type AnnotationsSupplier<Anns extends Record<string, unknown>> = {
  readonly annotations: Anns;
  readonly annsCatalog: AnnotationCatalog<Anns>;
  readonly language: LanguageSpec;
};

export function isAnnotationsSupplier<Anns extends Record<string, unknown>>(
  o: { language: LanguageSpec },
): o is AnnotationsSupplier<Anns> {
  return "annotations" in o && "annsCatalog" in o ? true : false;
}

/** Schema for typed TaskDirective from `Cell.pi?` property */
export const taskDirectiveSchema = z.discriminatedUnion("nature", [
  z.object({
    nature: z.literal("TASK"),
    identity: z.string().min(1), // required, names the task
    language: languageSpecSchema,
    deps: z.array(z.string()).optional(), // dependencies which allow DAGs to be created
  }).strict(),
  z.object({
    nature: z.literal("CONTENT"),
    identity: z.string().min(1), // required, names the task
    content: z.object().loose(),
    language: languageSpecSchema.optional(),
    deps: z.array(z.string()).optional(), // dependencies which allow DAGs to be created
  }).strict(),
  z.object({
    nature: z.literal("PARTIAL"),
    partial: mdFencedBlockPartialSchema,
  }).strict(),
]);

export type TaskDirective = z.infer<typeof taskDirectiveSchema>;

export const isTaskDirectiveSupplier = (
  o: unknown,
): o is {
  taskDirective: Extract<TaskDirective, { nature: "TASK" | "CONTENT" }>;
} =>
  o && typeof o === "object" && "taskDirective" in o &&
    typeof o.taskDirective === "object"
    ? true
    : false;

export type TaskCell<Provenance> = PlaybookCodeCell<Provenance> & Task & {
  taskDirective: Extract<TaskDirective, { nature: "TASK" | "CONTENT" }>;
};

export function matchTaskNature<U extends TaskCell<TasksProvenance>>(
  nature: TaskDirective["nature"],
): (t: Task) => t is U {
  return ((t: Task): t is U =>
    isTaskDirectiveSupplier(t) ? t.taskDirective.nature === nature : false);
}

export const isPartialDirectiveSupplier = (
  o: unknown,
): o is {
  partialDirective: Extract<TaskDirective, { nature: "PARTIAL" }>;
} =>
  o && typeof o === "object" && "partialDirective" in o &&
    typeof o.partialDirective === "object"
    ? true
    : false;

export type PartialCell<Provenance> = PlaybookCodeCell<Provenance> & {
  partialDirective: Extract<TaskDirective, { nature: "PARTIAL" }>;
};

export type TaskDirectiveInspector<
  Provenance,
  Frontmatter extends Record<string, unknown> = Record<string, unknown>,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
> = (
  ctx: {
    cell: PlaybookCodeCell<Provenance, CellAttrs>;
    pb: Playbook<Provenance, Frontmatter, CellAttrs, I>;
    registerIssue: (message: string, error?: unknown) => void;
  },
) => TaskDirective | false;

export function partialsInspector<
  Provenance,
  Frontmatter extends Record<string, unknown> = Record<string, unknown>,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(): TaskDirectiveInspector<Provenance, Frontmatter, CellAttrs, I> {
  return ({ cell, registerIssue }) => {
    if (!cell.parsedPI) return false;
    const pi = cell.parsedPI;
    if (pi && pi.firstToken?.toLocaleUpperCase() == "PARTIAL") {
      const fbc = {
        nature: "PARTIAL",
        partial: fbPartialCandidate(cell.parsedPI, cell.source, cell.attrs, {
          registerIssue,
        }),
      };
      const parsed = taskDirectiveSchema.safeParse(fbc);
      if (parsed.success) {
        return parsed.data;
      } else {
        registerIssue(
          `Zod error parsing task directive '${cell.pi}': ${
            z.prettifyError(parsed.error)
          }`,
          parsed.error,
        );
      }
    }
    return false;
  };
}

export const spawnableLangIds = ["shell"] as const;
export type SpawnableLangIds = typeof spawnableLangIds[number];
export const spawnableLangSpecs = spawnableLangIds.map((lid) => {
  const langSpec = languageRegistry.get(lid);
  if (!langSpec) throw new Error("this should never happen");
  return langSpec;
});

export function spawnableTDI<
  Provenance,
  Frontmatter extends Record<string, unknown> = Record<string, unknown>,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  isValidLanguage: (
    cell: PlaybookCodeCell<Provenance, CellAttrs>,
  ) => LanguageSpec | undefined = (cell) =>
    spawnableLangSpecs.find((lang) =>
      lang.id == cell.language || lang.aliases?.find((a) => a == cell.language)
    ),
): TaskDirectiveInspector<Provenance, Frontmatter, CellAttrs, I> {
  return ({ cell }) => {
    const language = isValidLanguage(cell);
    if (!language) return false;
    if (!cell.pi) return false;
    const pi = cell.parsedPI;
    if (!pi || !pi.firstToken) return false;
    return {
      nature: "TASK",
      identity: pi.firstToken,
      source: cell.source,
      language,
      deps: "dep" in pi.flags
        ? (typeof pi.flags.dep === "boolean"
          ? undefined
          : typeof pi.flags.dep === "string"
          ? [pi.flags.dep]
          : pi.flags.dep)
        : undefined,
    };
  };
}

// use this as a "catch all" when "unknown" cells just mean "any content"
export function anyNamedContentTDI<
  Provenance,
  Frontmatter extends Record<string, unknown> = Record<string, unknown>,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
>(
  langIfNotRegistered: (
    cell: PlaybookCodeCell<Provenance, CellAttrs>,
  ) => LanguageSpec = (cell) => ({
    id: cell.language,
    extensions: [
      cell.language.startsWith(".") ? cell.language : "." + cell.language,
    ],
    comment: { line: [], block: [] },
  }),
): TaskDirectiveInspector<Provenance, Frontmatter, CellAttrs, I> {
  return ({ cell }) => {
    const language =
      languageRegistry.values().find((lang) =>
        lang.id == cell.language ||
        lang.aliases?.find((a) => a == cell.language)
      ) ?? langIfNotRegistered(cell);
    if (!language) return false;
    const pi = cell.parsedPI;
    if (!pi || !pi.firstToken) return false;
    return {
      nature: "CONTENT",
      identity: pi.firstToken,
      source: cell.source,
      language,
      deps: pi
        ? "dep" in pi.flags
          ? (typeof pi.flags.dep === "boolean"
            ? undefined
            : typeof pi.flags.dep === "string"
            ? [pi.flags.dep]
            : pi.flags.dep)
          : undefined
        : undefined,
      content: {},
    };
  };
}

/**
 * A registry/dispatcher that inspects Markdown playbook code cells and turns them
 * into executable task directives. It aggregates issues, collects discovered tasks,
 * and wires fenced-block PARTIALs into the shared partials collection.
 *
 * The inspector pipeline is pluggable via {@link use}. If none are supplied, a
 * sensible default chain is installed:
 * 1) `partialsInspector()` – registers fenced-block PARTIALs first
 * 2) `denoTaskParser()`   – maps ` ```deno-task` cells to `Deno.Task`
 * 3) `spawnableParser()`  – maps ` ```sh|bash` cells to `Deno.Command` (shebang-aware)
 * 4) `spryParser()`       – maps ` ```spry` cells to `Cliffy.Command`
 *
 * Collected tasks are exposed on {@link tasks}; any parsing/validation problems are
 * accumulated on {@link issues}.
 *
 * @template Provenance Arbitrary provenance tag carried through notebooks and issues.
 * @template Frontmatter Parsed frontmatter shape for a notebook.
 * @template CellAttrs   Arbitrary attribute map attached to each code cell.
 * @template I           Issue type (defaults to `Issue<Provenance>`).
 */
export class TaskDirectives<
  Provenance,
  Frontmatter extends Record<string, unknown> = Record<string, unknown>,
  CellAttrs extends Record<string, unknown> = Record<string, unknown>,
  I extends Issue<Provenance> = Issue<Provenance>,
> {
  readonly virtualCells = pseudoCellsGenerator<
    Provenance,
    Frontmatter,
    CellAttrs,
    I
  >();
  readonly tdInspectors: TaskDirectiveInspector<
    Provenance,
    Frontmatter,
    CellAttrs,
    I
  >[] = [];
  readonly playbooks: Playbook<Provenance, Frontmatter, CellAttrs, I>[] = [];
  readonly issues: I[] = [];
  readonly tasks: TaskCell<Provenance>[] = [];
  readonly partialDirectives: PartialCell<Provenance>[] = [];
  readonly taskDepsCache = new Map<string, string[]>();

  constructor(
    readonly partials: ReturnType<typeof fbPartialsCollection>,
    tdInspectors?: TaskDirectiveInspector<
      Provenance,
      Frontmatter,
      CellAttrs,
      I
    >[],
  ) {
    if (tdInspectors) this.use(...tdInspectors);
    else {
      this.use(
        partialsInspector(), // put this first
        spawnableTDI(),
      );
    }
  }

  use(
    ...tdInspectors: TaskDirectiveInspector<
      Provenance,
      Frontmatter,
      CellAttrs,
      I
    >[]
  ) {
    this.tdInspectors.push(...tdInspectors);
    return this;
  }

  registerIssue(issue: I) {
    this.issues.push(issue);
  }

  /**
   * Find tasks that should be *implicitly* injected as dependencies of `taskId`
   * based on other tasks' `--injected-dep` flags, and report invalid regexes.
   *
   * Behavior:
   *
   * - Any task may declare `--injected-dep`. The value can be:
   *   - boolean true  → means ["*"] (match all taskIds)
   *   - string        → treated as [that string]
   *   - string[]      → used as-is
   *
   * - Each string is treated as a regular expression source. We compile all of them
   *   once and cache them in `t.parsedPI.flags[".injected-dep-cache"]` as `RegExp[]`.
   *
   * - Special case: "*" means "match everything", implemented as `/.*\/`.
   *
   * - If ANY compiled regex for task `t` matches the given `taskId`, then that task’s
   *   `parsedPI.firstToken` (the task's own name/id) will be considered an injected
   *   dependency. It will be added to the returned `injected` list unless it is already
   *   present in `taskDeps` or already added.
   *
   * Reliability:
   *
   * - The only error we surface is regex compilation failure. If a pattern cannot be
   *   compiled, it is skipped and recorded in `errors` as `{ taskId, regEx }`.
   *
   * - No exceptions propagate. Bad inputs are ignored safely.
   *
   * Assumptions:
   *
   * - `this.tasks` exists and is an array of task-like objects.
   * - Each task that participates has `parsedPI.firstToken` (string task name) and
   *   `parsedPI.flags` (an object).
   *
   * @param taskId The task identifier we are resolving deps for.
   *
   * @param taskDeps Existing, explicit dependencies for this task. Used only for de-duping.
   *
   * @example
   * ```ts
   * const { injected, errors } = this.injectedDeps("build", ["clean"]);
   * // injected could be ["lint","compile"]
   * // errors could be [{ taskId: "weirdTask", regEx: "(" }]
   * ```
   */
  injectedDeps(
    taskId: string,
    taskDeps: string[] = [],
  ) {
    const injected: string[] = [];
    const errors: { taskId: string; regEx: string }[] = [];

    // normalize taskDeps just in case caller passed something weird
    const safeTaskDeps = Array.isArray(taskDeps) ? taskDeps : [];

    for (const t of this.tasks) {
      if (!t || typeof t !== "object") continue;

      const parsedPI = t.parsedPI;
      if (!parsedPI || typeof parsedPI !== "object") continue;

      const flags = parsedPI.flags;
      if (!flags || typeof flags !== "object") continue;

      if (!("injected-dep" in flags)) continue;

      // Normalize `--injected-dep` forms into an array of string patterns
      const diFlag = flags["injected-dep"];
      let di: string[] = [];

      if (typeof diFlag === "boolean") {
        if (diFlag === true) {
          di = ["*"];
        }
      } else if (typeof diFlag === "string") {
        di = [diFlag];
      } else if (Array.isArray(diFlag)) {
        di = diFlag.filter((x) => typeof x === "string");
      }

      if (di.length === 0) continue;

      // Compile/cache regexes if not already done
      if (!Array.isArray(flags[".injected-dep-cache"])) {
        const compiledList: RegExp[] = [];

        for (const expr of di) {
          const source = expr === "*" ? ".*" : expr;

          try {
            compiledList.push(new RegExp(source));
          } catch {
            // Record invalid regex source
            errors.push({
              taskId:
                typeof parsedPI.firstToken === "string" && parsedPI.firstToken
                  ? parsedPI.firstToken
                  : "(unknown-task)",
              regEx: expr,
            });
            // skip adding invalid one
          }
        }

        // deno-lint-ignore no-explicit-any
        (flags as any)[".injected-dep-cache"] = compiledList;
      }

      // deno-lint-ignore no-explicit-any
      const cached = (flags as any)[".injected-dep-cache"] as RegExp[];

      if (!Array.isArray(cached) || cached.length === 0) {
        // nothing valid compiled, move on
        continue;
      }

      // Check whether ANY of the compiled regexes matches the requested taskId
      let matches = false;
      for (const re of cached) {
        if (re instanceof RegExp && re.test(taskId)) {
          matches = true;
          break;
        }
      }

      if (!matches) continue;

      // Inject this task's firstToken (the task name)
      const depName = parsedPI.firstToken;
      if (
        typeof depName === "string" &&
        depName.length > 0 &&
        !safeTaskDeps.includes(depName) &&
        !injected.includes(depName)
      ) {
        injected.push(depName);
      }
    }

    return { injected, errors };
  }

  /**
   * Returns a merged list of explicit and injected dependencies for a given task.
   *
   * This is a lightweight wrapper around {@link injectedDeps} that merges
   * the explicitly declared `taskDeps` (if any) with automatically injected
   * dependencies discovered via `--injected-dep` flags on other tasks.
   *
   * Results are cached per `taskId` in the provided `cellDepsCache` map.
   *
   * @param taskId The task identifier to resolve dependencies for.
   *
   * @param taskDeps Optional list of explicitly declared dependencies for this task.
   *
   * @param cellDepsCache Cache map used to store and retrieve previously resolved dependency lists.
   *
   * @returns A unique, ordered list of merged dependencies for the given `taskId`.
   *
   * @example
   * ```ts
   * const cache = new Map<string, string[]>();
   * const deps = this.cellDeps("build", ["clean"], cache);
   * // => ["clean", "compile", "lint"]
   * ```
   */
  taskDeps(
    taskId: string,
    taskDeps: string[] | undefined,
    cellDepsCache?: Map<string, string[]>,
  ) {
    // Return cached value if available
    if (cellDepsCache) {
      const cached = cellDepsCache.get(taskId);
      if (cached) return cached;
    }

    // Compute injected dependencies
    const { injected } = this.injectedDeps(taskId, taskDeps ?? []);

    // Merge explicit + injected dependencies, ensuring uniqueness and order
    const merged = Array.from(
      new Set([...injected, ...(taskDeps ?? [])]),
    );

    // Cache and return result
    cellDepsCache?.set(taskId, merged);
    return merged;
  }

  /**
   * Register a single code cell from a playbook. Each configured inspector is tried
   * in order until one returns a `TaskDirective`:
   *
   * - If the directive is of nature `"PARTIAL"`, it is added to the shared partials
   *   collection and nothing is pushed to {@link tasks}.
   * - If the directive is of nature `"TASK"`, the cell is augmented with a
   *   `taskDirective`, and `taskId()`/`taskDeps()` accessors are attached so it can
   *   participate in downstream planning and execution. The cell is then pushed to
   *   {@link tasks}.
   * - If no inspector recognizes the cell, the optional `onUnknown` callback is invoked.
   *
   * Any inspector/Zod parsing errors should call the provided `registerIssue` function;
   * errors are accumulated on {@link issues} instead of throwing, except for the
   * internal "should never happen" guard if a recognized TASK cell fails augmentation.
   *
   * @param cell The candidate code cell to inspect.
   * @param pb   The parent playbook containing this cell.
   * @param opts Optional hooks.
   * @param opts.onUnknown Called when no inspector claims the cell.
   * @returns `true` if the cell was claimed by an inspector (TASK or PARTIAL), `false` otherwise.
   *
   * @example
   * ```ts
   * const td = new TaskDirectives(partialsCollection);
   * td.register(cell, playbook, {
   *   onUnknown: (c) => td.registerIssue({
   *     kind: "fence-issue",
   *     disposition: "error",
   *     message: `Unrecognized code fence: \`\`\`${c.language}\` at ${c.startLine}`,
   *     provenance: playbook.notebook.provenance,
   *     startLine: c.startLine, endLine: c.endLine,
   *   } as Issue<Provenance>),
   * });
   * ```
   */
  register(
    cell: PlaybookCodeCell<Provenance, CellAttrs>,
    pb: Playbook<Provenance, Frontmatter, CellAttrs, I>,
    opts?: {
      onUnknown?: (
        cell: PlaybookCodeCell<Provenance, CellAttrs>,
        pb: Playbook<Provenance, Frontmatter, CellAttrs, I>,
      ) => void;
    },
  ) {
    const tdiInit = {
      cell,
      pb,
      registerIssue: (message: string, error?: unknown) =>
        this.registerIssue({
          kind: "fence-issue",
          disposition: "error",
          error: error,
          message,
          provenance: pb.notebook.provenance,
          startLine: cell.startLine,
          endLine: cell.endLine,
        } as I),
    };

    for (const tdi of this.tdInspectors) {
      const td = tdi(tdiInit);
      if (td) {
        switch (td.nature) {
          case "PARTIAL":
            this.partials.register(td.partial);
            (cell as Any).partialDirective = td;
            if (isPartialDirectiveSupplier(cell)) {
              this.partialDirectives.push(cell as PartialCell<Provenance>);
            } else {
              throw new Error("This should never happen");
            }
            return true;

          case "TASK":
          case "CONTENT": {
            (cell as Any).taskDirective = td;
            const task = cell as unknown as Task;
            task.taskId = () => td.identity;
            task.taskDeps = () =>
              this.taskDeps(td.identity, td.deps, this.taskDepsCache);
            if (isTaskDirectiveSupplier(cell)) {
              this.tasks.push(cell as TaskCell<Provenance>);
            } else {
              throw new Error("This should never happen");
            }
            return true;
          }
        }
      }
    }

    opts?.onUnknown?.(cell, pb);
    return false;
  }

  /**
   * Streams notebooks from `sources()`, validates each notebook's frontmatter against
   * an optional per-source `fmSchema`, and registers every code cell via {@link register}.
   *
   * Behavior:
   * - The `sources()` generator yields `Source` objects; if a yielded source provides
   *   `fmSchema`, the notebook’s frontmatter is validated (`safeParseAsync`). Failures
   *   are recorded as issues and the entire notebook is skipped (cells are not visited).
   * - Playbooks are produced by `playbooks(notebooks(sources()))`. Each code cell is
   *   handed to {@link register}. Unknown cells can be handled via `init?.onUnknown`.
   * - All issues discovered during parsing/validation are accumulated on {@link issues}.
   *
   * Markdown File
   *     ↓
   *     Markdown Fence
   *     ↓
   *     NotebookCodeCell (syntactic)
   *        ↓
   *        PlaybookCodeCell (contextual)
   *            ↓
   *            TaskDirective (semantic)
   *                ↓
   *                Task / TaskCell (executable)
   *
   * This function is side-effectful on the instance: it populates {@link tasks} and
   * {@link issues}, and registers PARTIALs into the provided partials collection.
   *
   * @param sources Async generator of notebook sources. You may attach an optional
   *                `fmSchema` per source to enforce frontmatter shape.
   * @param init    Optional options forwarded to {@link register} (e.g., `onUnknown`).
   *
   * @example
   * ```ts
   * // Provide sources with optional per-file frontmatter schemas
   * async function* sources() {
   *   yield {
   *     provenance: "/path/playbook.md",
   *     content: await Deno.readTextFile("/path/playbook.md"),
   *     fmSchema: z.object({ title: z.string().min(1) }),
   *   };
   * }
   *
   * const td = new TaskDirectives(partialsCollection);
   * await td.populate(sources, {
   *   onUnknown: (cell, pb) => td.registerIssue({
   *     kind: "fence-issue",
   *     disposition: "error",
   *     message: `Unknown code fence ${cell.language} in ${pb.notebook.provenance}`,
   *     provenance: pb.notebook.provenance,
   *     startLine: cell.startLine, endLine: cell.endLine,
   *   } as Issue<string>),
   * });
   *
   * console.log(td.tasks.length, "task(s) discovered");
   * console.log(td.issues);
   * ```
   */
  async populate(
    sources: () => AsyncGenerator<
      Source<Provenance> & { fmSchema?: z.ZodType }
    >,
    init?:
      & Parameters<
        TaskDirectives<Provenance, Frontmatter, CellAttrs, I>["register"]
      >[2]
      & {
        onVirtual?: (
          cell: CodeCell<Provenance, CellAttrs>,
          pb: Playbook<Provenance, Frontmatter, CellAttrs, I>,
        ) => void;
      },
  ) {
    const registerIssue = (...i: I[]) =>
      i.forEach((i) => this.registerIssue(i));
    const srcMap = new Map(
      (await Array.fromAsync(sources())).map((s) => [s.provenance, s]),
    );

    const { cellsFrom } = this.virtualCells;
    for await (
      const pb of playbooks(
        async function* () {
          for await (
            const nb of notebooks<Provenance, Frontmatter, CellAttrs, I>(
              sources(),
            )
          ) {
            const fmSchema = srcMap.get(nb.provenance)?.fmSchema;
            if (fmSchema) {
              const parsed = await fmSchema.safeParseAsync(nb.fm);
              if (!parsed.success) {
                const issueBase: Issue<Provenance> = {
                  kind: "frontmatter-parse",
                  provenance: nb.provenance,
                  disposition: "error",
                  message: z.prettifyError(parsed.error),
                  raw: nb.fm,
                  error: parsed.error,
                };
                registerIssue(issueBase as unknown as I);
                continue; // skip the notebook if it fails frontmatter validation
              }
            }
            // if any issues were registered with the Notebook, populate them too
            registerIssue(...nb.issues);

            yield nb;
          }
        }(),
        { kind: "hr" },
      )
    ) {
      this.playbooks.push(pb);
      for (const cell of pb.cells) {
        if (cell.kind === "code") {
          if (cell.language === "import") {
            for await (const c of cellsFrom(cell, pb)) {
              if (init?.onVirtual) init.onVirtual(c, pb);
              this.register(c, pb);
            }
          } else {
            this.register(cell, pb, init);
          }
        }
      }
    }
  }
}
