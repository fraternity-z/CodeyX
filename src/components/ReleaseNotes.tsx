import { Children, cloneElement, isValidElement, memo, useState, type MouseEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeHighlight from "rehype-highlight";

const anchorPrefix = "release-note-";
const schema = {
  ...defaultSchema,
  clobberPrefix: anchorPrefix,
  tagNames: ["a", "b", "blockquote", "br", "code", "dd", "del", "details", "div", "dl", "dt", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "kbd", "li", "ol", "p", "pre", "s", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "ul"],
  strip: ["script", "style", "iframe", "object", "embed", "form", "textarea", "button", "select", "svg", "math"],
  protocols: { ...defaultSchema.protocols, href: ["http", "https", "mailto"], src: ["https"] },
};

export function githubReleaseUrl(value?: string | null): string {
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password && !url.search && !url.hash
      && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/tag\/[^/]+$/.test(url.pathname)
      ? url.href : "";
  } catch {
    return "";
  }
}

export function releaseContentUrl(value: string, key: string, releaseUrl?: string): string {
  if (!value || /[\u0000-\u0020\u007f\\]/.test(value) || value.startsWith("//")) return "";
  try {
    if (key === "href" && value.startsWith("#")) return `#${anchorPrefix}${decodeURIComponent(value.slice(1))}`;
    let resolved = value;
    if (!/^[a-z][a-z\d+.-]*:/i.test(value)) {
      const source = githubReleaseUrl(releaseUrl);
      if (!source) return "";
      const [, owner, repository, , , tag] = new URL(source).pathname.split("/");
      const base = key === "src"
        ? `https://raw.githubusercontent.com/${owner}/${repository}/${tag}/`
        : `https://github.com/${owner}/${repository}/blob/${tag}/`;
      resolved = new URL(value, base).href;
    }
    const url = new URL(resolved);
    if (url.username || url.password) return "";
    const protocols = key === "src" ? ["https:"] : ["https:", "http:", "mailto:"];
    return protocols.includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function ReleaseImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const [failed, setFailed] = useState(false);
  return src && !failed
    ? <img src={src} alt={alt || "更新截图"} title={title} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    : <span className="release-notes-image-fallback">图片未加载：{alt || "更新截图"}</span>;
}

const alertLabels = { NOTE: "提示", TIP: "建议", IMPORTANT: "重要", WARNING: "警告", CAUTION: "注意" };

function ReleaseQuote({ children }: { children?: ReactNode }) {
  const blocks: ReactNode[] = Children.toArray(children);
  const index = blocks.findIndex(child => isValidElement(child) && child.type === "p");
  const paragraph = blocks[index];
  if (!isValidElement<{ children?: ReactNode }>(paragraph)) return <blockquote>{children}</blockquote>;
  const parts = Children.toArray(paragraph.props.children);
  const match = typeof parts[0] === "string" && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/.exec(parts[0]);
  if (!match) return <blockquote>{children}</blockquote>;
  parts[0] = (parts[0] as string).slice(match[0].length);
  blocks[index] = parts.some(Boolean) ? cloneElement(paragraph, {}, ...parts) : null;
  return <blockquote data-release-alert={match[1].toLowerCase()}><p className="release-notes-alert-title">{alertLabels[match[1] as keyof typeof alertLabels]}</p>{blocks}</blockquote>;
}

function followReleaseAnchor(event: MouseEvent<HTMLElement>) {
  const link = event.target instanceof Element ? event.target.closest("a") : null;
  const href = link?.getAttribute("href");
  if (!href?.startsWith(`#${anchorPrefix}`)) return;
  event.preventDefault();
  const target = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[id]")).find(element => element.id === href.slice(1));
  if (!target) return;
  for (let parent = target.parentElement; parent && parent !== event.currentTarget; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  target.scrollIntoView({ block: "start" });
}

export const ReleaseNotes = memo(function ReleaseNotes({ markdown, title, releaseUrl }: { markdown: string; title?: string; releaseUrl?: string }) {
  return <article className="release-notes" aria-label="更新公告" onClick={followReleaseAnchor}>
    {title && <h2 className="release-notes-title">{title}</h2>}
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSlug, [rehypeSanitize, schema], [rehypeHighlight, { detect: false }]]}
      urlTransform={(url, key) => releaseContentUrl(url, key, releaseUrl)}
      components={{
        a: ({ href, children, title, id }) => href
          ? <a id={id} href={href} title={title} target={href.startsWith("#") ? undefined : "_blank"} rel={href.startsWith("#") ? undefined : "noopener noreferrer"}>{children}</a>
          : <span id={id}>{children}</span>,
        img: ({ src, alt, title }) => <ReleaseImage key={src} src={src} alt={alt} title={title} />,
        table: ({ children }) => <div className="release-notes-table" role="region" aria-label="公告表格" tabIndex={0}><table>{children}</table></div>,
        blockquote: ReleaseQuote,
      }}
    >{markdown}</Markdown>
  </article>;
});
