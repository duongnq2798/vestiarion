/**
 * A small highlighter for the landing's code showcase: the three languages its snippets are in, read line by line into
 * tokens that put the line back together exactly. Shiki highlights the docs on the server; this keeps the landing's
 * client bundle to a few hundred lines of known code, with nothing to load before the panel can draw.
 */

export type Lang = "bash" | "ts" | "json";

export type TokenKind = "plain" | "comment" | "string" | "keyword" | "command" | "flag" | "variable" | "property" | "number" | "punctuation";

export interface Token {
  kind: TokenKind;
  text: string;
}

const TS_KEYWORDS = new Set(["import", "from", "const", "let", "await", "new", "export", "return", "async", "function", "type", "true", "false", "null"]);
const JSON_LITERALS = new Set(["true", "false", "null"]);
const BASH_COMMANDS = new Set(["curl", "claude", "npm", "npx"]);

/** The first match of `pattern` at `index`, or null. */
function at(line: string, index: number, pattern: RegExp): string | null {
  const sticky = new RegExp(pattern.source, "y");
  sticky.lastIndex = index;
  return sticky.exec(line)?.[0] ?? null;
}

/** The next character after `index` that is not a space. */
function nextVisible(line: string, index: number): string {
  return line.slice(index).trimStart()[0] ?? "";
}

function bash(line: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let commandSeen = false;
  while (index < line.length) {
    const before = index === 0 ? " " : line[index - 1];
    const spaced = /\s/.test(before);
    let match: string | null;
    if (spaced && (match = at(line, index, /#.*/))) tokens.push({ kind: "comment", text: match });
    else if ((match = at(line, index, /"(?:[^"\\]|\\.)*"|'[^']*'/))) tokens.push({ kind: "string", text: match });
    else if ((match = at(line, index, /\$\{?[A-Za-z_]\w*\}?/))) tokens.push({ kind: "variable", text: match });
    else if (spaced && (match = at(line, index, /--?[A-Za-z][\w-]*/))) tokens.push({ kind: "flag", text: match });
    else if ((match = at(line, index, /\\$/))) tokens.push({ kind: "punctuation", text: match });
    else if ((match = at(line, index, /[A-Za-z_][\w.-]*/))) {
      const command = !commandSeen && line.slice(0, index).trim() === "" && BASH_COMMANDS.has(match);
      if (command) commandSeen = true;
      tokens.push({ kind: command ? "command" : "plain", text: match });
    } else tokens.push({ kind: "plain", text: (match = line[index]) });
    index += match.length;
  }
  return tokens;
}

function typescript(line: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < line.length) {
    let match: string | null;
    if ((match = at(line, index, /\/\/.*/))) tokens.push({ kind: "comment", text: match });
    else if ((match = at(line, index, /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/))) tokens.push({ kind: "string", text: match });
    else if ((match = at(line, index, /\d+(?:\.\d+)?/))) tokens.push({ kind: "number", text: match });
    else if ((match = at(line, index, /[A-Za-z_$][\w$]*/))) {
      const next = nextVisible(line, index + match.length);
      const kind: TokenKind = TS_KEYWORDS.has(match) ? "keyword" : next === "(" ? "command" : next === ":" ? "property" : "plain";
      tokens.push({ kind, text: match });
    } else if ((match = at(line, index, /[{}()[\];,.:=!?<>]/))) tokens.push({ kind: "punctuation", text: match });
    else tokens.push({ kind: "plain", text: (match = line[index]) });
    index += match.length;
  }
  return tokens;
}

function json(line: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < line.length) {
    let match: string | null;
    if ((match = at(line, index, /"(?:[^"\\]|\\.)*"/))) {
      tokens.push({ kind: nextVisible(line, index + match.length) === ":" ? "property" : "string", text: match });
    } else if ((match = at(line, index, /-?\d+(?:\.\d+)?/))) tokens.push({ kind: "number", text: match });
    else if ((match = at(line, index, /[a-z]+/)) && JSON_LITERALS.has(match)) tokens.push({ kind: "keyword", text: match });
    else if ((match = at(line, index, /[{}[\]:,]/))) tokens.push({ kind: "punctuation", text: match });
    else tokens.push({ kind: "plain", text: (match = line[index]) });
    index += match.length;
  }
  return tokens;
}

const READERS: Record<Lang, (line: string) => Token[]> = { bash, ts: typescript, json };

/** Each line of `code` as tokens, neighbours of one kind joined; every line's tokens spell it exactly. */
export function highlight(code: string, lang: Lang): Token[][] {
  return code.split("\n").map((line) =>
    READERS[lang](line).reduce<Token[]>((merged, token) => {
      const last = merged.at(-1);
      if (last && last.kind === token.kind) last.text += token.text;
      else merged.push({ ...token });
      return merged;
    }, []),
  );
}
