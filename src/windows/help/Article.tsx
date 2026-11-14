// A Help article, typeset: the blocks of ./markdown.ts as elements, with every occurrence of the
// search text marked (the block the match cursor is on more strongly), and links that stay inside
// Help (`help:<id>`) or open in the browser (http, https). An example block (2.1) is a named group
// of buttons: "Open This Example" and, when the article names a method, "Open and Run". Nothing an
// article contains is ever set as HTML.
import { Fragment, type ReactNode } from "react";
import { FolderOpen, Play } from "lucide-react";
import { Icon } from "../../components/Icon";
import { matchRanges, shownHeadline, type Block, type Inline } from "./markdown";
import { helpWords as w } from "./words";

export interface ArticleProps {
  blocks: Block[];
  /** The search text; "" for none. */
  query: string;
  /** The index (into `blocks`) of the block the match cursor is on. */
  currentBlock: number | null;
  /** A `help:<id>` link was followed. */
  onTopic: (id: string) => void;
  /** An http(s) link was followed. */
  onExternal: (url: string) => void;
  /** An example block's button was pressed: open the bundled example `name`, and start `run` when it is given. */
  onExample?: (name: string, run: string | null) => void;
  /** The plain name of a Run-menu command ("Whitt QNA"), for the Open and Run button's tooltip. */
  methodName?: (run: string) => string;
}

const HELP_LINK = /^help:([A-Za-z][A-Za-z0-9_-]*)$/;

/** Where a link in an article goes. Anything that is neither is shown as plain text. */
export function linkTarget(href: string): { kind: "topic"; id: string } | { kind: "external"; url: string } | null {
  const m = HELP_LINK.exec(href);
  if (m) return { kind: "topic", id: m[1] };
  return /^https?:\/\/[^\s]+$/i.test(href) ? { kind: "external", url: href } : null;
}

function Marked({ text, query, current }: { text: string; query: string; current: boolean }) {
  const ranges = query ? matchRanges(text, query) : [];
  if (!ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([from, to], i) => {
    if (from > at) out.push(<Fragment key={`t${i}`}>{text.slice(at, from)}</Fragment>);
    out.push(
      <mark key={`m${i}`} className={current ? "help-mark current" : "help-mark"}>
        {text.slice(from, to)}
      </mark>,
    );
    at = to;
  });
  if (at < text.length) out.push(<Fragment key="end">{text.slice(at)}</Fragment>);
  return <>{out}</>;
}

export function Article({ blocks, query, currentBlock, onTopic, onExternal, onExample, methodName }: ArticleProps) {
  const run = (inline: Inline[], current: boolean): ReactNode =>
    inline.map((i, k) => {
      switch (i.t) {
        case "text":
          return <Marked key={k} text={i.s} query={query} current={current} />;
        case "code":
          return (
            <code key={k}>
              <Marked text={i.s} query={query} current={current} />
            </code>
          );
        case "strong":
          return <strong key={k}>{run(i.c, current)}</strong>;
        case "em":
          return <em key={k}>{run(i.c, current)}</em>;
        case "br":
          return <br key={k} />;
        case "link": {
          const target = linkTarget(i.href);
          if (!target) return <Fragment key={k}>{run(i.c, current)}</Fragment>;
          return (
            <a
              key={k}
              className="help-link"
              href={target.kind === "topic" ? `#${target.id}` : target.url}
              data-help-link={target.kind === "topic" ? target.id : undefined}
              onClick={(e) => {
                e.preventDefault();
                if (target.kind === "topic") onTopic(target.id);
                else onExternal(target.url);
              }}
            >
              {run(i.c, current)}
            </a>
          );
        }
      }
    });

  return (
    <article className="help-page">
      {blocks.map((b, idx) => {
        const current = idx === currentBlock;
        const indent = "level" in b && b.level ? { marginLeft: `calc(var(--sp-7) * ${b.level})` } : undefined;
        const common = { "data-block": idx, "data-current": current ? "" : undefined } as const;
        switch (b.kind) {
          case "title":
            return (
              <h1 key={idx} className="help-title" {...common}>
                {run(b.inline, current)}
              </h1>
            );
          case "headline": {
            const Tag = b.depth <= 2 ? "h2" : "h3";
            return (
              <Tag key={idx} className="help-headline" {...common}>
                {run(shownHeadline(b), current)}
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={idx} className="help-para" style={indent} {...common}>
                {run(b.inline, current)}
              </p>
            );
          case "bullet":
            return (
              <div key={idx} className="help-bullet" style={indent} {...common}>
                <span className={b.marker.length > 1 ? "help-marker numbered" : "help-marker"} aria-hidden={b.marker.length > 1 ? undefined : true}>
                  {b.marker}
                </span>
                <span className="help-bullet-text">{run(b.inline, current)}</span>
              </div>
            );
          case "code":
            return (
              <pre key={idx} className="help-code" style={indent} tabIndex={0} {...common}>
                {b.lines.map((l, n) => (
                  <Fragment key={n}>
                    <Marked text={l} query={query} current={current} />
                    {"\n"}
                  </Fragment>
                ))}
              </pre>
            );
          case "example":
            return (
              <div key={idx} className="help-example" style={indent} role="group" aria-label={w.example.label(b.example)} data-help-example={b.example} {...common}>
                <span className="help-example-text">
                  <Marked text={b.text} query={query} current={current} />
                </span>
                <span className="help-example-actions">
                  <button type="button" className="btn" title={w.example.openHelp(b.example)} onClick={() => onExample?.(b.example, null)}>
                    <Icon icon={FolderOpen} size={12} />
                    {w.example.open}
                  </button>
                  {b.run && (
                    <button type="button" className="btn primary" data-help-run={b.run} title={w.example.runHelp(b.example, methodName?.(b.run) ?? b.run)} onClick={() => onExample?.(b.example, b.run)}>
                      <Icon icon={Play} size={12} />
                      {w.example.run}
                    </button>
                  )}
                </span>
              </div>
            );
          case "table":
            return (
              <div key={idx} className="help-table-wrap" style={indent} {...common}>
                <table className="help-table">
                  <thead>
                    <tr>
                      {b.header.map((c, n) => (
                        <th key={n} scope="col">
                          {run(c, current)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, n) => (
                      <tr key={n}>
                        {r.map((c, m) => (
                          <td key={m}>{run(c, current)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </article>
  );
}
