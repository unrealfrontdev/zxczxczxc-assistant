/// <reference types="vite/client" />

// react-markdown v9+ and remark-gfm v4+ are ESM-only.
// Vite resolves them at runtime; these declarations satisfy the TS language server.
declare module "react-markdown" {
  import type { ComponentType } from "react";
  interface Options {
    children: string;
    remarkPlugins?: unknown[];
    components?: Record<string, ComponentType<unknown>>;
  }
  const ReactMarkdown: ComponentType<Options>;
  export default ReactMarkdown;
}

declare module "remark-gfm" {
  // remark-gfm ships its own types; this ambient fallback prevents TS6133 in strict mode
  const remarkGfm: unknown;
  export default remarkGfm;
}
