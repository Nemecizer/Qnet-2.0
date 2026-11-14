// Release notes, shown safely. The text comes from the update server, so it is never given to the
// page as HTML: it is read line by line into React elements (headings, bullet lists, paragraphs),
// and everything else — tags, links, images, scripts — stays the literal characters it was sent as.
import type { ReactNode } from "react";

export type NoteBlock = { kind: "heading" | "paragraph"; text: string } | { kind: "list"; items: string[] };

/** Emphasis marks are dropped, not interpreted: "**Faster** `charts`" reads "Faster charts". */
function plain(text: string): string {
  return text.replace(/(\*\*|__|`)/g, "").trim();
}

/** The notes as blocks: `#` headings, `-`/`*`/`•` bullets, blank-line-separated paragraphs. */
export function noteBlocks(notes: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", text: para.join(" ") });
    para = [];
  };
  for (const raw of notes.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (!line) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", text: plain(heading[1]) });
    } else if (bullet) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list") last.items.push(plain(bullet[1]));
      else blocks.push({ kind: "list", items: [plain(bullet[1])] });
    } else {
      para.push(plain(line));
    }
  }
  flush();
  return blocks;
}

export function ReleaseNotes({ notes }: { notes: string }): ReactNode {
  return noteBlocks(notes).map((b, i) =>
    b.kind === "heading" ? (
      <h3 key={i} className="upd-notes-heading">{b.text}</h3>
    ) : b.kind === "list" ? (
      <ul key={i} className="upd-notes-list">
        {b.items.map((item, j) => (
          <li key={j}>{item}</li>
        ))}
      </ul>
    ) : (
      <p key={i}>{b.text}</p>
    ),
  );
}
