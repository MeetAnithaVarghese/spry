import * as z from "@zod/zod";
import type { HookDefn } from "./hook.ts";
import { hookDefn, IssueSinkSchema } from "./hook.ts";

/**
 * Progressive hook definitions for documentation/tests.
 */

/* -------------------------------------------------------------------------- */
/* 0) Simplest possible hook: pure args -> value                               */
/* -------------------------------------------------------------------------- */

export const add = hookDefn(
  "spry.math.add",
  { input: [z.number(), z.number()], output: z.number() },
);

/* -------------------------------------------------------------------------- */
/* 1) Next simplest: one object arg, no optional surfaces                      */
/* -------------------------------------------------------------------------- */

export const MinimalCtxSchema = z.object({
  file: z.string(),
});

export const minimalOnLoaded = hookDefn(
  "spry.playbook.minimalOnLoaded",
  { input: [MinimalCtxSchema], output: z.void() },
);

/* -------------------------------------------------------------------------- */
/* 2) Add issues: runtime-validatable IssueSink surface                        */
/* -------------------------------------------------------------------------- */

export const IssuesCtxSchema = z.object({
  file: z.string(),
  issues: IssueSinkSchema.optional(),
});

export const onLoadedWithIssues = hookDefn(
  "spry.playbook.onLoadedWithIssues",
  { input: [IssuesCtxSchema], output: z.void() },
);

/* -------------------------------------------------------------------------- */
/* 3) Add bus: type-safe events + type-safe bus surface                        */
/* -------------------------------------------------------------------------- */

export type OnLoadedEvents = {
  note: { message: string };
  warn: { code: string; message?: string };
};

export type HookBus<E extends Record<string, unknown>> = Readonly<{
  emit<K extends keyof E & string>(type: K, detail: E[K]): void;

  on<K extends keyof E & string>(
    type: K,
    handler: (detail: E[K]) => void,
    opts?: Readonly<{ signal?: AbortSignal }>,
  ): () => void;

  once<K extends keyof E & string>(
    type: K,
    opts?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<E[K]>;
}>;

export const BusCtxSchema = z.object({
  file: z.string(),
  issues: IssueSinkSchema.optional(),
  bus: z.custom<HookBus<OnLoadedEvents>>().optional(),
});

export const onLoadedWithBus: HookDefn<
  [typeof BusCtxSchema],
  z.ZodVoid,
  OnLoadedEvents
> = hookDefn(
  "spry.playbook.onLoadedWithBus",
  { input: [BusCtxSchema], output: z.void() },
  { bus: true },
) as unknown as HookDefn<[typeof BusCtxSchema], z.ZodVoid, OnLoadedEvents>;

/* -------------------------------------------------------------------------- */
/* 4) Add AbortSignal: progressive lifecycle/cancellation example              */
/* -------------------------------------------------------------------------- */

export const FullCtxSchema = z.object({
  file: z.string(),
  text: z.string(),
  issues: IssueSinkSchema.optional(),
  bus: z.custom<HookBus<OnLoadedEvents>>().optional(),
  signal: z.custom<AbortSignal>().optional(),
});

export const onLoadedFull: HookDefn<
  [typeof FullCtxSchema],
  z.ZodVoid,
  OnLoadedEvents
> = hookDefn(
  "spry.playbook.onLoadedFull",
  { input: [FullCtxSchema], output: z.void() },
  { bus: true },
) as unknown as HookDefn<[typeof FullCtxSchema], z.ZodVoid, OnLoadedEvents>;

/* -------------------------------------------------------------------------- */
/* 5) Defensive wrapper demo                                                   */
/* -------------------------------------------------------------------------- */

export const explode = hookDefn(
  "spry.test.explode",
  { input: [z.string()], output: z.never() },
);
