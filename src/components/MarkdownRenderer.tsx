/**
 * MarkdownRenderer — renders AI responses as proper formatted Markdown.
 * Uses react-markdown v9 + remark-gfm + react-syntax-highlighter.
 */

import ReactMarkdown from "react-markdown";
// react-markdown v9: Components map; typed via explicit cast below
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useState } from "react";
import type { ComponentType, ReactNode } from "react";

interface Props {
  text: string;
  fontSize?: number;
  /** Strip <<<FILE / DELETE markers before rendering */
  stripFileBlocks?: boolean;
}

function stripMarkers(text: string): string {
  return text
    .replace(/<<<FILE:[^\n>]+>>>\n[\s\S]*?<<<END_FILE>>>/g, "")
    .replace(/<<<DELETE_FILE:[^\n>]+>>>/g, "");
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <button
      onClick={copy}
      className="text-[9px] px-1.5 py-0.5 rounded
        bg-white/10 hover:bg-white/20 text-white/40 hover:text-white/80
        transition-colors font-mono"
    >
      {copied ? "✓" : "copy"}
    </button>
  );
}

// Separate component for code blocks to keep the JSX tree clean
function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const match = /language-(\w+)/.exec(className ?? "");
  const codeStr = String(children).replace(/\n$/, "");
  const lang = match?.[1] ?? "text";
  const isBlock = codeStr.includes("\n") || !!match;

  if (!isBlock) {
    return (
      <code className="bg-white/10 text-emerald-300 px-1 py-0.5 rounded text-[0.85em] font-mono">
        {children}
      </code>
    );
  }

  return (
    <div className="relative my-2 rounded-xl overflow-hidden border border-white/10">
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.06] border-b border-white/[0.07]">
        <span className="text-[9px] font-mono text-white/30 uppercase tracking-wider">{lang}</span>
        <CopyButton code={codeStr} />
      </div>
      <SyntaxHighlighter
        style={oneDark}
        language={lang}
        PreTag="div"
        customStyle={{
          margin: 0,
          padding: "12px 16px",
          background: "transparent",
          fontSize: "0.82em",
          lineHeight: 1.5,
        }}
        codeTagProps={{ style: { fontFamily: "ui-monospace, monospace" } }}
      >
        {codeStr}
      </SyntaxHighlighter>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mdComponents: Record<string, ComponentType<any>> = {
  code: ({ children, className }) => (
    <CodeBlock className={className}>{children}</CodeBlock>
  ),
  h1: ({ children }) => (
    <h1 className="text-base font-semibold text-white/90 mt-3 mb-1.5 border-b border-white/10 pb-1">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-sm font-semibold text-white/85 mt-2.5 mb-1">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[0.85em] font-semibold text-white/80 mt-2 mb-0.5">{children}</h3>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-blue-400 underline underline-offset-2 hover:text-blue-300 transition-colors"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="text-xs border-collapse w-full">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="px-2 py-1 text-left text-white/70 font-semibold border border-white/10 bg-white/[0.06]">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-2 py-1 text-white/60 border border-white/10">{children}</td>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-white/20 pl-3 text-white/50 italic my-2">
      {children}
    </blockquote>
  ),
  ul: ({ children }) => (
    <ul className="list-disc list-inside space-y-0.5 my-1.5 pl-1">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-inside space-y-0.5 my-1.5 pl-1">{children}</ol>
  ),
  hr: () => <hr className="border-none border-t border-white/10 my-3" />,
  p: ({ children }) => (
    <p className="my-1 leading-relaxed whitespace-pre-wrap break-words text-white/85">{children}</p>
  ),
};

export default function MarkdownRenderer({ text, fontSize = 14, stripFileBlocks = false }: Props) {
  const content = stripFileBlocks ? stripMarkers(text) : text;

  return (
    <div
      className="prose prose-invert prose-sm max-w-none
        prose-p:my-1 prose-p:leading-relaxed
        prose-headings:text-white/90 prose-headings:font-semibold
        prose-a:text-blue-400 prose-a:underline-offset-2 hover:prose-a:text-blue-300
        prose-strong:text-white/90
        prose-em:text-purple-300/90
        prose-blockquote:border-l-white/20 prose-blockquote:text-white/50
        prose-hr:border-white/10
        prose-table:text-xs prose-th:text-white/70 prose-td:text-white/60
        prose-li:my-0.5"
      style={{ fontSize }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
