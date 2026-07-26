import { type ComponentProps, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils.ts";

export type MarkdownProps = {
  children: string;
  className?: string;
};

const components: ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ className, ...props }) => (
    <p
      className={cn(
        "whitespace-pre-wrap break-words leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
  a: ({ className, ...props }) => (
    <a
      target="_blank"
      rel="noreferrer"
      className={cn(
        "text-primary underline-offset-4 hover:underline",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("leading-relaxed", className)} {...props} />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "my-2 border-l-2 border-border pl-3 italic text-muted-foreground",
        className,
      )}
      {...props}
    />
  ),
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "mt-4 mb-2 text-base font-semibold tracking-tight",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "mt-3 mb-2 text-sm font-semibold tracking-tight",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "mt-3 mb-1 text-sm font-semibold tracking-tight",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn("my-3 border-border", className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong
      className={cn("font-semibold text-foreground", className)}
      {...props}
    />
  ),
  em: ({ className, ...props }) => (
    <em className={cn("italic", className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table
        className={cn("w-full border-collapse text-xs", className)}
        {...props}
      />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "border border-border bg-muted px-2 py-1 text-left font-semibold",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn("border border-border px-2 py-1 align-top", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "my-2 overflow-x-auto rounded-md border border-border bg-muted/60 px-3 py-2 text-xs leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = /\blanguage-/.test(className ?? "");
    if (isBlock) {
      return (
        <code className={cn("font-mono text-[0.85em]", className)} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className={cn(
          "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    );
  },
};

function MarkdownInner({ children, className }: MarkdownProps) {
  return (
    <div className={cn("text-sm text-foreground", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(
  MarkdownInner,
  (prev, next) =>
    prev.children === next.children && prev.className === next.className,
);
