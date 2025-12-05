import {
  assert,
  assertEquals,
  assertGreater,
  assertMatch,
} from "jsr:@std/assert@^1";
import {
  safeSourceText,
  SourceRelativeTo,
} from "../../universal/content-acquisition.ts";
import { Issue, Notebook } from "../governedmd.ts";
import { notebooks } from "./notebook.ts";
import { Playbook, PlaybookCodeCell, playbooks } from "./playbook.ts";

async function loadFixture(): Promise<string> {
  const safeText = await safeSourceText(
    new URL("./notebook_test-fixture-01.md", import.meta.url),
    SourceRelativeTo.Module,
  );
  if (safeText.nature === "error") {
    console.error(safeText.error);
  }
  assert(safeText.nature != "error");
  return safeText.text;
}

Deno.test("playbooks — default delimiter (H2 headings)", async () => {
  const md = await loadFixture();

  // Parse with core (generic defaults OK: FM/Attrs inferred, Issue = base Issue)
  const parsed: Notebook<string>[] = [];
  for await (const nb of notebooks({ provenance: "prime", content: md })) {
    parsed.push(nb);
  }

  assertEquals(parsed.length, 1);
  const nb = parsed[0];

  // Sanity: mdast cache exists & looks consistent
  assert(Array.isArray(nb.ast.mdastByCell));
  assert(Array.isArray(nb.ast.codeCellIndices));
  assertGreater(nb.ast.mdastByCell.length, 0);

  // Enrich with playbooks (default delimiter: { kind: "heading", level: 2 })
  const outs: Playbook<
    string,
    Record<string, unknown>,
    Record<string, unknown>,
    Issue<string>
  >[] = [];
  for await (const out of playbooks(parsed)) outs.push(out);

  assertEquals(outs.length, 1);
  const pb = outs[0];

  // ---------- Notebook-level header instructions ----------
  // Should include everything after FM up to first code fence:
  // - Intro paragraphs (2)
  // - The HR and the paragraph right after it
  // - The H2 "Section A" and the section intro paragraph
  assert(pb.instructions);
  const headerText = pb.instructions?.text ?? "";
  assertMatch(headerText, /Intro paragraph line one/i);
  assertMatch(headerText, /Intro paragraph line two/i);
  assertMatch(
    headerText,
    /This paragraph appears immediately after a thematic break/i,
  );
  assertMatch(headerText, /Section A/i);
  assertMatch(headerText, /This section introduces a SQL example/i);

  // ---------- Notebook-level appendix ----------
  // Should include the trailing paragraph after the final thematic break
  assert(pb.appendix);
  const appendixText = pb.appendix?.text ?? "";
  assertMatch(appendixText, /trailing paragraph/i);

  // Helper to pick code cells by language in order
  const code = (lang: string, idx = 0) => {
    const all = pb.cells.filter((c): c is PlaybookCodeCell<string> =>
      c.kind === "code" && c.language === lang
    );
    return all[idx];
  };

  // Cells by expected order from existing core_test.ts:
  // 3: sql, 5: bash, 7: json, 9: xml, 11: csv, 13: fish, 14: text (raw)
  const sql = code("sql")!;
  const bash = code("bash")!;
  const json = code("json")!;
  const xml = code("xml")!;
  const csv = code("csv")!;
  const fish = code("fish")!;
  const plainTextCell = pb.cells.find(
    (c): c is PlaybookCodeCell<string> =>
      c.kind === "code" && c.language === "text",
  )!;

  // ---------- Per-code-cell instructions with H2 delimiter ----------

  // SQL code: buffer should include H2 "Section A" + its intro paragraph
  assert(sql.instructions, "expected SQL cell to have instructions");
  assertMatch(sql.instructions!.text, /Section A/i);
  assertMatch(sql.instructions!.text, /This section introduces a SQL example/i);

  // Bash code: buffer should be only the narrative after SQL (no heading in between)
  assert(bash.instructions, "expected bash cell to have instructions");
  assertMatch(bash.instructions!.text, /After the SQL code fence/i);

  // JSON code: buffer should include H2 "Section B" + its intro paragraph
  assert(json.instructions, "expected json cell to have instructions");
  assertMatch(json.instructions!.text, /Section B/i);
  assertMatch(
    json.instructions!.text,
    /This section shows JSON and XML code fences/i,
  );

  // XML code: buffer should be the short narrative "The XML export block follows..."
  assert(xml.instructions, "expected xml cell to have instructions");
  assertMatch(xml.instructions!.text, /The XML export block follows/i);

  // CSV code: includes H2 "Section C" + its intro sentence
  assert(csv.instructions, "expected csv cell to have instructions");
  assertMatch(csv.instructions!.text, /Section C/i);
  assertMatch(csv.instructions!.text, /contains CSV and Fish shell examples/i);

  // FISH code: buffer should be narrative after CSV ("After the CSV code fence...")
  assert(fish.instructions, "expected fish cell to have instructions");
  assertMatch(fish.instructions!.text, /After the CSV code fence/i);

  // Raw text code (the triple-backtick without lang): occurs right after fish with no intervening markdown;
  // buffer should be empty -> no instructions
  assertEquals(plainTextCell.instructions, undefined);
});

Deno.test("playbooks — alternative delimiter (thematic breaks / hr)", async () => {
  const md = await loadFixture();

  const parsed: Notebook<string>[] = [];
  for await (const nb of notebooks({ provenance: "prime", content: md })) {
    parsed.push(nb);
  }
  assertEquals(parsed.length, 1);

  const outs: Playbook<
    string,
    Record<string, unknown>,
    Record<string, unknown>,
    Issue<string>
  >[] = [];
  for await (const out of playbooks(parsed, { kind: "hr" })) {
    outs.push(out);
  }

  assertEquals(outs.length, 1);
  const pb = outs[0];

  // With HR delimiters, the pre-Section-A HR will clear buffer, so SQL instructions
  // should still include the H2 "Section A" heading and its intro paragraph (since they are
  // after that HR). This ensures behavior remains sensible with HR-based delimiting.
  const sql = pb.cells.find(
    (c): c is PlaybookCodeCell<string> =>
      c.kind === "code" && c.language === "sql",
  )!;
  assert(
    sql.instructions,
    "expected SQL cell to have instructions under HR delimiter",
  );
  const sqlText = sql.instructions?.text ?? "";
  assertMatch(sqlText, /Section A/i);
  assertMatch(sqlText, /This section introduces a SQL example/i);

  // Appendix should be the same regardless of delimiter
  assert(pb.appendix);
  assertMatch(pb.appendix!.text, /trailing paragraph/i);
});
