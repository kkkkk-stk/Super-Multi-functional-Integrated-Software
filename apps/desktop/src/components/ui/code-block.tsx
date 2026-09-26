import { Check, Copy } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/system";
import { cn } from "@/lib/utils";

/**
 * 只读代码块（带行号 + 轻量高亮）。
 *
 * ## 为什么自己写高亮
 *
 * 需求是"等宽字体、行号、只读、YAML/代码要能看清结构"。为这个引 highlight.js
 * （几百 KB）或 shiki（更重，还要 wasm）不划算 —— 依赖清单也是锁定的。
 *
 * 这里做的是**逐行正则着色**，只区分四类 token：注释、键名、字符串、数字/布尔。
 * 它不追求语法完备（也不该），但足以让 plugin.yaml 的层级一眼可读。
 * 输出是 React 元素而不是 `dangerouslySetInnerHTML`，所以即使内容来自 AI
 * 也不存在注入风险。
 */

export type CodeLanguage = "yaml" | "python" | "json" | "text";

export interface CodeBlockProps {
  code: string;
  language?: CodeLanguage;
  /** 起始行号（片段展示时用） */
  startLine?: number;
  /** 显示行号 */
  showLineNumbers?: boolean;
  maxHeight?: number;
  className?: string;
  title?: string;
}

const TOKEN_STYLES = {
  comment: "text-muted-foreground/70 italic",
  key: "text-sky-300",
  string: "text-emerald-300",
  number: "text-amber-300",
  keyword: "text-fuchsia-300",
  punctuation: "text-muted-foreground",
} as const;

export function CodeBlock({
  code,
  language = "text",
  startLine = 1,
  showLineNumbers = true,
  maxHeight = 380,
  className,
  title,
}: CodeBlockProps) {
  const lines = React.useMemo(() => code.replace(/\r\n/g, "\n").split("\n"), [code]);
  const [copied, setCopied] = React.useState(false);

  const onCopy = async () => {
    await copyText(code, "已复制代码");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={cn("overflow-hidden rounded-md border border-border/60 bg-black/35", className)}>
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">
          {title ?? language}
          <span className="ml-2 text-muted-foreground/60">{lines.length} 行</span>
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="复制全部内容"
          onClick={() => void onCopy()}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>

      <div
        className="overflow-auto font-mono text-[11.5px] leading-[1.65] scrollbar-thin"
        style={{ maxHeight }}
        // 只读区域：读屏会按行朗读，键盘可以聚焦后用方向键滚动
        tabIndex={0}
        role="region"
        aria-label={title ?? "代码内容"}
      >
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, idx) => (
              <tr key={idx} className="hover:bg-white/[0.03]">
                {showLineNumbers && (
                  <td className="w-10 select-none border-r border-border/40 px-2 text-right align-top text-muted-foreground/50">
                    {startLine + idx}
                  </td>
                )}
                <td className="whitespace-pre px-3 align-top">
                  {highlightLine(line, language).map((token, i) => (
                    <span key={i} className={token.className}>
                      {token.text}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface Token {
  text: string;
  className?: string;
}

function highlightLine(line: string, language: CodeLanguage): Token[] {
  if (line.length === 0) return [{ text: " " }];

  // 注释优先：整行不再做其它着色
  const commentMarker = language === "yaml" ? "#" : "#";
  const trimmed = line.trimStart();
  if (trimmed.startsWith(commentMarker)) {
    return [{ text: line, className: TOKEN_STYLES.comment }];
  }

  if (language === "yaml") {
    // `key:` / `- key:` / `key: value`
    const yamlKey = /^(\s*(?:-\s+)?)([A-Za-z_][\w.-]*)(\s*:\s*)(.*)$/.exec(line);
    if (yamlKey) {
      const [, indent, key, colon, rest] = yamlKey;
      const tokens: Token[] = [
        { text: indent },
        { text: key, className: TOKEN_STYLES.key },
        { text: colon, className: TOKEN_STYLES.punctuation },
      ];
      const valueComment = rest.indexOf(" #");
      const value = valueComment >= 0 ? rest.slice(0, valueComment) : rest;
      const comment = valueComment >= 0 ? rest.slice(valueComment) : "";
      tokens.push(...highlightScalar(value, language));
      if (comment) tokens.push({ text: comment, className: TOKEN_STYLES.comment });
      return tokens;
    }
    return highlightScalar(line, language);
  }

  if (language === "python" || language === "json") {
    return highlightScalar(line, language);
  }

  return [{ text: line }];
}

const KEYWORDS = new Set([
  "def",
  "return",
  "import",
  "from",
  "if",
  "else",
  "elif",
  "for",
  "while",
  "with",
  "as",
  "class",
  "try",
  "except",
  "finally",
  "True",
  "False",
  "None",
  "true",
  "false",
  "null",
]);

function highlightScalar(text: string, language: CodeLanguage): Token[] {
  const tokens: Token[] = [];
  // 一次扫描：字符串 / 数字 / 布尔 / 关键字 / 其它
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w.]*)|(\s+|[^\w\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [whole, str, num, word] = match;
    if (str) {
      tokens.push({ text: whole, className: TOKEN_STYLES.string });
    } else if (num) {
      tokens.push({ text: whole, className: TOKEN_STYLES.number });
    } else if (word) {
      tokens.push({
        text: whole,
        className:
          language !== "text" && KEYWORDS.has(word) ? TOKEN_STYLES.keyword : undefined,
      });
    } else {
      tokens.push({ text: whole });
    }
  }
  return tokens.length > 0 ? tokens : [{ text }];
}
