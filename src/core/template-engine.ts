type TemplateNode =
  | { kind: "text"; value: string }
  | { kind: "field"; path: string }
  | { kind: "if"; path: string; truthy: TemplateNode[]; falsy: TemplateNode[] }
  | { kind: "range"; path: string; children: TemplateNode[] };

type Token = { kind: "text"; value: string } | { kind: "expression"; value: string };

export function renderTemplateText(template: string, context: Record<string, unknown>): string {
  const tokens = tokenize(template);
  const parsed = parseSequence(tokens, 0, new Set()).nodes;
  return renderNodes(parsed, { root: context, current: context });
}

function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open < 0) {
      tokens.push({ kind: "text", value: template.slice(cursor) });
      break;
    }
    if (template.startsWith("{{{", open)) {
      const endOfMarker = template.indexOf("\n", open);
      const end = endOfMarker < 0 ? template.length : endOfMarker + 1;
      if (open > cursor) tokens.push({ kind: "text", value: template.slice(cursor, open) });
      tokens.push({ kind: "text", value: template.slice(open, end) });
      cursor = end;
      continue;
    }
    if (open > cursor) tokens.push({ kind: "text", value: template.slice(cursor, open) });
    const close = template.indexOf("}}", open + 2);
    if (close < 0) {
      tokens.push({ kind: "text", value: template.slice(open) });
      break;
    }
    tokens.push({
      kind: "expression",
      value: template.slice(open + 2, close).replace(/^-/, "").replace(/-$/, "").trim(),
    });
    cursor = close + 2;
  }
  return tokens;
}

function parseSequence(tokens: Token[], start: number, stops: Set<string>): {
  nodes: TemplateNode[];
  next: number;
  stop?: string;
} {
  const nodes: TemplateNode[] = [];
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.kind === "text") {
      nodes.push({ kind: "text", value: token.value });
      index += 1;
      continue;
    }
    const [keyword = "", ...rest] = token.value.split(/\s+/);
    if (stops.has(keyword)) return { nodes, next: index + 1, stop: keyword };
    if (keyword === "if") {
      const truthy = parseSequence(tokens, index + 1, new Set(["else", "end"]));
      let falsy: TemplateNode[] = [];
      let next = truthy.next;
      if (truthy.stop === "else") {
        const parsedFalse = parseSequence(tokens, next, new Set(["end"]));
        falsy = parsedFalse.nodes;
        next = parsedFalse.next;
      }
      nodes.push({ kind: "if", path: normalizePath(rest.join(" ")), truthy: truthy.nodes, falsy });
      index = next;
      continue;
    }
    if (keyword === "range") {
      const children = parseSequence(tokens, index + 1, new Set(["end"]));
      nodes.push({ kind: "range", path: normalizePath(rest.join(" ")), children: children.nodes });
      index = children.next;
      continue;
    }
    if (keyword === "else" || keyword === "end") {
      throw new Error(`模板存在多余的 {{${keyword}}}`);
    }
    nodes.push({ kind: "field", path: normalizePath(token.value) });
    index += 1;
  }
  if (stops.size) throw new Error(`模板缺少 {{end}}`);
  return { nodes, next: index };
}

function renderNodes(nodes: TemplateNode[], scope: { root: Record<string, unknown>; current: unknown }): string {
  let output = "";
  for (const node of nodes) {
    if (node.kind === "text") output += node.value;
    else if (node.kind === "field") output += stringify(resolvePath(scope, node.path));
    else if (node.kind === "if") {
      output += renderNodes(truthy(resolvePath(scope, node.path)) ? node.truthy : node.falsy, scope);
    } else {
      const collection = resolvePath(scope, node.path);
      if (Array.isArray(collection)) {
        for (const item of collection) output += renderNodes(node.children, { ...scope, current: item });
      }
    }
  }
  return output;
}

function resolvePath(scope: { root: Record<string, unknown>; current: unknown }, path: string): unknown {
  if (!path || path === ".") return scope.current;
  const parts = path.split(".").filter(Boolean);
  const first = parts[0];
  let value: unknown;
  if (first && scope.current && typeof scope.current === "object" && first in scope.current) value = scope.current;
  else value = scope.root;
  for (const part of parts) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function stringify(value: unknown): string {
  return value == null ? "" : String(value);
}

function normalizePath(path: string): string {
  return path.trim().replace(/^\./, "");
}
