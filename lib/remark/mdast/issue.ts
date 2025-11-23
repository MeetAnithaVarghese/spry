import z from "@zod/zod";
import { nodeArrayDataFactory } from "./safe-data.ts";

export type Issue<Severity extends string, Baggage = unknown> = {
  readonly severity: Severity;
  readonly message: string;
} & Baggage;

export function flexibleNodeIssues<Key extends string, Baggage = unknown>(
  key: Key,
) {
  return nodeArrayDataFactory<
    Key,
    Issue<
      "info" | "warning" | "error" | "fatal",
      { error?: Error | z.ZodError } & Baggage
    >
  >(key);
}

export function nodeErrors<
  Key extends string,
  Baggage = Record<string, unknown>,
>(key: Key) {
  return nodeArrayDataFactory<Key, Issue<"error", Baggage>>(key);
}

export function nodeLint<Key extends string, Baggage = unknown>(key: Key) {
  return nodeArrayDataFactory<
    Key,
    & { readonly severity: "info" | "warning"; readonly message: string }
    & Baggage
  >(key);
}
