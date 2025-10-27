import { z } from "jsr:@zod/zod@4";
import {
  CodeCell,
  fbPartialCandidate,
  fbPartialsCollection,
  Issue,
  mdFencedBlockPartialSchema,
  notebooks,
  Playbook,
  PlaybookCodeCell,
  playbooks,
  pseudoCellsGenerator,
  Source,
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

/** Schema for typed TaskDirective from `Cell.info?` property */
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
    if (!cell.parsedInfo) return false;
    const pi = cell.parsedInfo;
    if (pi && pi.firstToken?.toLocaleUpperCase() == "PARTIAL") {
      const fbc = {
        nature: "PARTIAL",
        partial: fbPartialCandidate(cell.parsedInfo, cell.source, cell.attrs, {
          registerIssue,
        }),
      };
      const parsed = taskDirectiveSchema.safeParse(fbc);
      if (parsed.success) {
        return parsed.data;
      } else {
        registerIssue(
          `Zod error parsing task directive '${cell.info}': ${
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
    if (!cell.info) return false;
    const pi = cell.parsedInfo;
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
            task.taskDeps = () => td.deps;
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
