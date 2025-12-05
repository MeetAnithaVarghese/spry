import { assertEquals } from "@std/assert";
import { MarkdownDoc } from "./fluent-md.ts";

const unit: typeof Deno.test =
  (Reflect.get(Deno, "unit") as typeof Deno.test) ?? Deno.test;

unit(
  "md-doc-gen end-to-end: complex fluent build matches golden fixture",
  async () => {
    const md = new MarkdownDoc({ anchors: true });

    // Front matter (via @std/yaml)
    md.frontMatterOnce({
      title: "Fluent MD Example",
      tags: ["deno", "md"],
      draft: false,
      version: 1,
    });

    // Core sections (reopenable) + ordering control
    md.section("Introduction", (m) => m.p("Small description."));

    md.section("Getting Started", (m) => {
      m.code("bash", "deno run -A main.ts");
    });

    md.section(
      "Getting Started",
      (m) => m.ul("Install Deno", "Run the script"),
    );

    md.after("Background").section("Findings", (m) => m.p("Key results."));

    // Additional content variety
    md.section("Appendix", (m) => {
      m.h2("A");
      m.h3("B");
      m.h4("C");
      // Only h2 and h3 go in the TOC here
      m.toc([2, 3], { scope: "section", includeSectionHeading: false });
    });

    md.section("Table Demo", (m) => {
      m.table(
        ["H1", "H2", "H3"],
        [
          ["a", "b\nb2", "c"],
          ["longer", "", "right"],
        ],
        ["left", "center", "right"],
      );
    });

    md.section("Code Demo", (m) => {
      m.code("ts", "const a = `tick`;", "const b = '```';");
      m.codeTag("bash")`
      echo "hello"
      cat <<'EOF'
      inside
      \`\`\`
      EOF
    `;
    });

    md.section("Links & Media", (m) => {
      m.link("OpenAI", "https://openai.com");
      m.image("Alt", "https://example.org/img.png");
      m.quote("quoted", "text");
      m.checkbox("Done", true);
      m.checkbox("Todo", false);
    });

    // Rename a section (updates heading + slug)
    md.renameSection("Introduction", "Intro");

    // Remove a scratch section if we accidentally created one (no-op safety)
    md.removeSection("Scratch");

    const actual = md.write();
    const expected = await Deno.readTextFile(
      // this doesn't end in `.md` because Deno tries to format *.md
      new URL("fluent-md_test-golden.fixture", import.meta.url),
    );
    assertEquals(actual, expected);
  },
);
