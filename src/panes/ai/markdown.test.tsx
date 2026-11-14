// Markdown in assistant replies (ledger AI-072…074).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { columnAlignment, isNumericText, Markdown, parseMarkdown, tableTSV, type Block } from "./markdown";

const md = (text: string, q = "", onCopy = vi.fn(), onMenu = vi.fn()) => render(<Markdown text={text} q={q} onCopy={onCopy} onMenu={onMenu} />);

describe("parseMarkdown", () => {
  it("reads headings, paragraphs, nested lists, quotes, rules and fenced code (AI-072)", () => {
    const blocks = parseMarkdown("# Title\n\nSome *text*\nacross lines.\n\n- one\n  - nested\n- two\n\n1. first\n2. second\n\n> quoted\n> more\n\n---\n\n```python\nprint(1)\n\n  x = 2\n```\nafter");
    expect(blocks).toEqual<Block[]>([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "Some *text*\nacross lines." },
      { kind: "listItem", marker: "•", depth: 1, text: "one" },
      { kind: "listItem", marker: "•", depth: 2, text: "nested" },
      { kind: "listItem", marker: "•", depth: 1, text: "two" },
      { kind: "listItem", marker: "1.", depth: 1, text: "first" },
      { kind: "listItem", marker: "2.", depth: 1, text: "second" },
      { kind: "quote", text: "quoted\nmore" },
      { kind: "rule" },
      { kind: "code", text: "print(1)\n\n  x = 2" },
      { kind: "paragraph", text: "after" },
    ]);
  });

  it("falls back to one plain paragraph for text with no blocks", () => {
    expect(parseMarkdown("")).toEqual([{ kind: "paragraph", text: "" }]);
    expect(parseMarkdown("just words | with a bar")).toEqual([{ kind: "paragraph", text: "just words | with a bar" }]);
  });

  it("reads a table with its alignments, and right-aligns all-number columns when the source gives none (AI-073)", () => {
    const [t] = parseMarkdown("| Station | ρ | Share | Note |\n|---|---|:-:|---|\n| S1 | 0.80 | 12% | ok |\n| S2 | 1,250 | 8% | |") as Extract<Block, { kind: "table" }>[];
    expect(t.header).toEqual(["Station", "ρ", "Share", "Note"]);
    expect(t.rows).toEqual([["S1", "0.80", "12%", "ok"], ["S2", "1,250", "8%", ""]]);
    expect([0, 1, 2, 3].map((c) => columnAlignment(t, c))).toEqual(["left", "right", "center", "left"]);
    expect(tableTSV(t)).toBe("Station\tρ\tShare\tNote\nS1\t0.80\t12%\tok\nS2\t1,250\t8%\t");
    expect(["12%", "1,250", "-0.5", "1e-3", "", "S1", "1.2.3"].map(isNumericText)).toEqual([true, true, true, true, false, false, false]);
  });
});

describe("Markdown", () => {
  it("draws inline code, strong and emphasis, and a table with a header row", () => {
    md("Use `rate=1.0` for **S1**, _not_ S2.\n\n| a | b |\n|---|---|\n| x | 2 |");
    expect(screen.getByText("rate=1.0").tagName).toBe("CODE");
    expect(screen.getByText("S1").tagName).toBe("STRONG");
    expect(screen.getByText("not").tagName).toBe("EM");
    const table = screen.getByRole("table", { name: "Table, 1 rows, 2 columns" });
    expect(table.querySelectorAll("th")).toHaveLength(2);
    expect(table.querySelector("td[data-align='right']")?.textContent).toBe("2");
  });

  it("marks search hits inside prose and code", () => {
    const { container } = md("The rate is high.\n\n```\nrate=2\n```", "RATE");
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["rate", "rate"]);
  });

  it("offers Show all N lines on a block over 12 lines, and Copy on its context menu (AI-074)", () => {
    const onCopy = vi.fn();
    const onMenu = vi.fn();
    const code = Array.from({ length: 13 }, (_, i) => `line ${i + 1}`).join("\n");
    md(`\`\`\`\n${code}\n\`\`\`\n\n\`\`\`\nshort\n\`\`\``, "", onCopy, onMenu);
    const toggle = screen.getByRole("button", { name: "Show all 13 lines" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    const well = screen.getAllByLabelText("Code block")[0];
    expect(well).not.toHaveAttribute("data-expanded");
    fireEvent.click(toggle);
    expect(well).toHaveAttribute("data-expanded");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(well).not.toHaveAttribute("data-expanded");
    fireEvent.contextMenu(well);
    const items = onMenu.mock.calls[0][1] as { label: string; run: () => void }[];
    expect(items.map((i) => i.label)).toEqual(["Copy"]);
    items[0].run();
    expect(onCopy).toHaveBeenCalledWith(code);
  });

  it("offers Copy Table (TSV) on a table", () => {
    const onCopy = vi.fn();
    const onMenu = vi.fn();
    md("| a | b |\n|---|---|\n| **x** | 2 |", "", onCopy, onMenu);
    fireEvent.contextMenu(screen.getByRole("table"));
    const items = onMenu.mock.calls[0][1] as { label: string; run: () => void }[];
    expect(items[0].label).toBe("Copy Table (TSV)");
    items[0].run();
    expect(onCopy).toHaveBeenCalledWith("a\tb\nx\t2");
  });
});
