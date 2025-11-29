import { fromFileUrl, join, relative } from "@std/path";

export function fixturesFactory(
  resolve: ImportMeta["resolve"],
  fixtureHome: string,
) {
  const fixturePath = (rel: string) => resolve("./" + join(fixtureHome, rel));
  const pmdPath = (rel: string) =>
    fromFileUrl(resolve("./" + join(fixtureHome, "pmd", rel)));
  const sundryPath = (rel: string) =>
    fromFileUrl(resolve("./" + join(fixtureHome, "sundry", rel)));
  const goldenPath = (rel: string) =>
    fromFileUrl(resolve("./" + join(fixtureHome, "golden", rel)));
  return {
    relToCWD: (candidate: string) => relative(Deno.cwd(), candidate),

    path: fixturePath,
    textContent: async (rel: string) =>
      await Deno.readTextFile(fixturePath(rel)),
    textContentSync: (rel: string) => Deno.readTextFileSync(fixturePath(rel)),

    pmdPath,
    pmdTextContent: async (rel: string) =>
      await Deno.readTextFile(sundryPath(rel)),
    pmdTextContentSync: (rel: string) => Deno.readTextFileSync(sundryPath(rel)),

    sundryPath,
    sundryTextContent: async (rel: string) =>
      await Deno.readTextFile(sundryPath(rel)),
    sundryTextContentSync: (rel: string) =>
      Deno.readTextFileSync(sundryPath(rel)),

    goldenPath,
    goldenTextContent: async (rel: string) =>
      await Deno.readTextFile(goldenPath(rel)),
    goldenTextContentSync: (rel: string) =>
      Deno.readTextFileSync(goldenPath(rel)),
  };
}
