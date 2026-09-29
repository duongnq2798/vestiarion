import type { DocOperation } from "@/lib/api/openapi";

/**
 * The request samples on each reference page, built from the operation: the
 * same URL in cURL, JavaScript and Python. The key is always read from the
 * `VESTIARION_API_KEY` environment variable; a sample never carries a key.
 *
 * Only types come from `@/lib/api/openapi`, so a client component (Try it)
 * can import `requestUrl` without bundling the schemas.
 */

export type SampleLang = "curl" | "javascript" | "python";

/** The part of an operation a URL is built from: plain data, safe to hand to a client component. */
type UrlSpec = Pick<DocOperation, "path" | "params">;

/**
 * The operation's URL on `origin`: each path parameter filled in and
 * URL-encoded (`<name>` when it has no value), then the query parameters that
 * have a non-empty value, in the order the operation lists them. Names the
 * operation does not take are ignored.
 */
export function requestUrl(op: UrlSpec, origin: string, values: Record<string, string>): string {
  const value = (name: string) => (Object.hasOwn(values, name) ? values[name].trim() : "");
  const path = op.path.replace(/\{(\w+)\}/g, (_match, name: string) => (value(name) ? encodeURIComponent(value(name)) : `<${name}>`));
  const query = new URLSearchParams();
  for (const param of op.params) {
    if (param.in === "query" && value(param.name)) query.append(param.name, value(param.name));
  }
  const search = query.toString();
  return `${origin.replace(/\/+$/, "")}${path}${search ? `?${search}` : ""}`;
}

/**
 * The request as cURL, JavaScript (`fetch`) and Python (`requests`). The URL
 * is written as a JSON string, which is a valid string literal in all three:
 * encoded, it holds no quote, `$` or backslash.
 */
export function sampleRequest(op: DocOperation, origin: string, values: Record<string, string> = {}): Record<SampleLang, string> {
  const url = JSON.stringify(requestUrl(op, origin, values));
  return {
    curl: [`curl ${url} \\`, `  -H "Authorization: Bearer $VESTIARION_API_KEY"`].join("\n"),
    javascript: [
      `const response = await fetch(${url}, {`,
      "  headers: { Authorization: `Bearer ${process.env.VESTIARION_API_KEY}` },",
      "});",
      "const body = await response.json();",
      "console.log(response.status, body);",
    ].join("\n"),
    python: [
      "import os",
      "",
      "import requests",
      "",
      "response = requests.get(",
      `    ${url},`,
      '    headers={"Authorization": "Bearer " + os.environ["VESTIARION_API_KEY"]},',
      "    timeout=30,",
      ")",
      "print(response.status_code, response.json())",
    ].join("\n"),
  };
}
