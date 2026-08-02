import React, { useEffect, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify'; // H-9 fix: import the sanitizer

interface Props {
  content: string;
}

export function MarkdownRenderer({ content }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      // SECURITY: marked does NOT sanitize; LLM output is untrusted and may
      // contain raw HTML. DOMPurify strips scripts/event handlers before the
      // HTML touches the DOM (paired with the webview CSP from Task 3).
      const raw = marked.parse(content) as string;
      ref.current.innerHTML = DOMPurify.sanitize(raw);
    }
  }, [content]);

  return <div ref={ref} className="markdown-body" />;
}
