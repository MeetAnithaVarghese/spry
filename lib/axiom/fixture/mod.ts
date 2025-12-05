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
    text: async (rel: string, data?: string) =>
      data
        ? await Deno.writeTextFile(fixturePath(rel), data)
        : await Deno.readTextFile(fixturePath(rel)),
    json: async (rel: string, data?: string, pretty?: "pretty") =>
      data
        ? await Deno.writeTextFile(
          fixturePath(rel),
          JSON.stringify(data, null, pretty ? 2 : 0),
        )
        : JSON.parse(await Deno.readTextFile(fixturePath(rel))),

    pmdPath,
    pmdText: async (rel: string, data?: string) =>
      data
        ? await Deno.writeTextFile(pmdPath(rel), data)
        : await Deno.readTextFile(pmdPath(rel)),

    sundryPath,
    sundryText: async (rel: string, data?: string) =>
      data
        ? await Deno.writeTextFile(sundryPath(rel), data)
        : await Deno.readTextFile(sundryPath(rel)),

    goldenPath,
    goldenText: async (rel: string, data?: string) =>
      data
        ? await Deno.writeTextFile(goldenPath(rel), data)
        : await Deno.readTextFile(goldenPath(rel)),
    goldenJSON: async (rel: string, data?: unknown, pretty?: "pretty") =>
      data
        ? await Deno.writeTextFile(
          goldenPath(rel),
          JSON.stringify(data, null, pretty ? 2 : 0),
        )
        : JSON.parse(await Deno.readTextFile(goldenPath(rel))),
  };
}
