import z from "@zod/zod";
import {
  AnnotationCatalog,
  extractAnnotationsFromText,
} from "./code-comments.ts";
import { LanguageSpec } from "./code.ts";

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
