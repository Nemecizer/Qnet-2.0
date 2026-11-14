// 0.90.34's `Qnet --dump-help <topic>` printed how Help typesets a topic, one block per line, for
// checking the typesetter without opening the window. 2.0 has no such flag (ledger CLI-008,
// HELP-019: the typesetter is this folder's markdown.ts, not a binary), so the check it allowed is
// made here, for every topic: the dump of each article is well formed, complete, and free of
// Markdown the typesetter should have consumed.
import { describe, expect, it } from "vitest";
import { dumpBlocks, inlineText, type Block } from "./markdown";
import { KEYBOARD_SHORTCUTS, topicBlocks, TOPICS } from "./topics";

const HEAD = /^(TITLE {5}\| \S.*|HEADLINE {2}\| \S.*|PARA {6}\| \S.*|BULLET\d {3}\| (•|\d+\.) .*|CODE {6}\||TABLE {5}\||EXAMPLE {3}\| \S+( run:[a-z-]+)? \| \S.*)$/;
const CONTINUATION = /^ {10}\| {3}.*$/;

/** A block as `dumpBlocks` prints it, written out independently of it. */
function expected(b: Block): string[] {
  switch (b.kind) {
    case "title":
      return [`TITLE     | ${b.text}`];
    case "headline":
      return [`HEADLINE  | ${b.text}`];
    case "paragraph":
      return [`PARA      | ${b.text}`];
    case "bullet":
      return [`BULLET${b.level}   | ${b.marker} ${b.text}`];
    case "code":
      return ["CODE      |", ...b.lines.map((l) => `          |   ${l}`)];
    case "example":
      return [`EXAMPLE   | ${b.example}${b.run ? ` ${b.run}` : ""} | ${b.text}`];
    case "table":
      // The rows' layout is tableLines' (covered in help.test.tsx); here, their count and cells.
      return ["TABLE     |", ...Array.from({ length: b.rows.length + 2 }, () => "")];
  }
}

describe("the block dump of every Help topic (0.90.34 --dump-help)", () => {
  it("covers every topic of the manifest (0.90.34's and 2.1's)", () => {
    expect(TOPICS).toHaveLength(59);
  });

  it.each(TOPICS.map((t) => t.id))("%s: one well-formed line per block, a single title first, and no Markdown left over", (id) => {
    const blocks = topicBlocks(id);
    const dump = dumpBlocks(blocks);
    expect(dump.endsWith("\n")).toBe(true);
    const lines = dump.slice(0, -1).split("\n");

    // Every line is a block's head or a code or table line under one.
    for (const [i, line] of lines.entries()) expect(HEAD.test(line) || CONTINUATION.test(line), `${id} line ${i + 1}: ${line}`).toBe(true);
    const heads = lines.filter((l) => !CONTINUATION.test(l));
    expect(heads).toHaveLength(blocks.length);
    expect(lines[0]).toMatch(/^TITLE {5}\| /);
    expect(heads.filter((l) => l.startsWith("TITLE "))).toHaveLength(1);
    expect(heads.filter((l) => l.startsWith("HEADLINE ")).length, `${id} has sections`).toBeGreaterThan(0);

    // Block by block, in order, with nothing dropped.
    let at = 0;
    for (const b of blocks) {
      const want = expected(b);
      const got = lines.slice(at, at + want.length);
      if (b.kind === "table") {
        expect(got[0]).toBe(want[0]);
        expect(got.slice(1).every((l) => CONTINUATION.test(l)), `${id}: a table's rows`).toBe(true);
        for (const cell of [b.header, ...b.rows].flat().map(inlineText)) if (cell) expect(got.slice(1).join("\n"), `${id}: table cell “${cell}”`).toContain(cell);
      } else expect(got, `${id} block ${blocks.indexOf(b)}`).toEqual(want);
      at += want.length;
    }
    expect(at).toBe(lines.length);

    // Nothing the typesetter should have consumed reaches the page: heading marks, list marks,
    // fences, HTML and comment markers, link syntax. Code and table lines keep what they say.
    for (const line of heads) {
      const text = line.slice(line.indexOf("|") + 1);
      expect(text, `${id}: ${line}`).not.toMatch(/^\s*(#{1,6} |```|~~~|[-*+] |> )|<!--|-->|\]\((help:|https?:|qnet-example:)/);
    }
    // Levels are what the page can indent, and a paragraph's text is one line.
    for (const b of blocks) {
      if ("level" in b) expect(b.level, id).toBeLessThanOrEqual(3);
      if (b.kind !== "code") expect(b.text, id).not.toContain("\n");
    }
  });

  it("includes the generated Keyboard Shortcuts lists, from the live menu", () => {
    const dump = dumpBlocks(topicBlocks(KEYBOARD_SHORTCUTS));
    for (const menu of ["FILE", "EDIT", "VIEW", "RUN", "WINDOW", "HELP"]) expect(dump).toContain(`\nHEADLINE  | ${menu}\n`);
    expect(dump).toMatch(/^ {10}\| {3}\s*⌘N\s+New Network$/m);
    expect(dump).not.toContain("generated:");
  });
});
