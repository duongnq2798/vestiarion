"use client";

import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { cn } from "@/components/ui/cn";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import type { DocParam } from "@/lib/api/openapi";
import { requestUrl } from "@/lib/docs/samples";
import { LINK_CLASS } from "./InlineText";

/**
 * A plain, serialisable slice of a `DocOperation`: everything "Try it" needs
 * to build a URL and its inputs, and nothing that would pull `@/lib/api/openapi`'s
 * runtime module (zod, the example JSON) into this client component. Only
 * `DocParam` is imported as a type here.
 */
export type TryItOperation = { id: string; path: string; params: DocParam[] };

export type TryItResult =
  | { kind: "ok"; status: number; ok: boolean; elapsedMs: number; body: unknown }
  | { kind: "refused" }
  | { kind: "network-error" };

/** Shown with a 401, alongside the API's own body. */
export const AUTHENTICATION_HINT = "Create a key on your workspace's Settings page (owners and admins)";

/** The one path every "Try it" request must stay inside. */
function isAllowedUrl(url: string, origin: string): boolean {
  return url.startsWith(`${origin.replace(/\/+$/, "")}/api/v1/`);
}

/**
 * Sends one "Try it" request and reports the outcome. Takes `origin` and
 * `fetchImpl` as arguments instead of reading `window`/`fetch` itself, so it
 * runs the same in the browser and in a test, and so it is provably free of
 * any `window`, `Storage`, `localStorage`, `sessionStorage` or history
 * reference — the key lives only in the caller's React state, never here.
 *
 * The key is trimmed; an empty key sends no `Authorization` header. The URL
 * is `requestUrl(op, origin, values)`, which URL-encodes every path
 * parameter — so a value like `../../etc` becomes a literal path segment,
 * not a way out of `/api/v1/` — but the prefix is still checked before
 * anything is sent, and refused rather than trusted.
 */
export async function runTryIt(
  op: Pick<TryItOperation, "path" | "params">,
  origin: string,
  key: string,
  values: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<TryItResult> {
  const url = requestUrl(op, origin, values);
  if (!isAllowedUrl(url, origin)) return { kind: "refused" };

  const trimmedKey = key.trim();
  const headers: Record<string, string> = trimmedKey ? { Authorization: `Bearer ${trimmedKey}` } : {};

  const start = Date.now();
  try {
    const response = await fetchImpl(url, { headers, cache: "no-store" });
    const elapsedMs = Date.now() - start;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => "");
    }
    return { kind: "ok", status: response.status, ok: response.ok, elapsedMs, body };
  } catch {
    return { kind: "network-error" };
  }
}

const RESPONSE_PRE_CLASS = cn(
  "overflow-x-auto rounded-xl border border-ink/10 bg-ink px-4 py-3.5 font-mono text-[0.8125rem] leading-relaxed text-ground shadow-control"
);

/** What "Send" produced, purely from `result` — split out so it renders (and tests) the same without a live request. */
export function TryItResultView({ result }: { result: TryItResult | null }) {
  if (result === null) return null;

  if (result.kind === "refused") {
    return (
      <Callout tone="refused" title="Refused" role="alert" className="mt-4">
        The built URL does not stay inside this origin&rsquo;s <code>/api/v1/</code>, so nothing was sent.
      </Callout>
    );
  }

  if (result.kind === "network-error") {
    return (
      <Callout tone="refused" role="alert" className="mt-4">
        The request did not complete.
      </Callout>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={result.ok ? "proof" : "refused"} dot>
          {result.status}
        </Badge>
        <span className="text-xs text-ink-3">{result.elapsedMs} ms</span>
      </div>
      {result.status === 401 && (
        <Callout tone="refused" className="mt-1">
          <Link href="/docs/get-started/authentication" className={LINK_CLASS}>
            {AUTHENTICATION_HINT}
          </Link>
        </Callout>
      )}
      <pre className={RESPONSE_PRE_CLASS}>{JSON.stringify(result.body, null, 2)}</pre>
    </div>
  );
}

/**
 * Calls the real `/api/v1` endpoint from the reference page, with a key the
 * reader pastes in. The key lives in this component's state only: never
 * `localStorage`, `sessionStorage`, a cookie, a URL or a log.
 */
export default function TryIt({ op }: { op: TryItOperation }) {
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TryItResult | null>(null);
  const [sending, setSending] = useState(false);

  function paramValue(name: string): string {
    const raw = values[name] ?? "";
    return raw === "any" ? "" : raw;
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setResult(null);
    const origin = window.location.origin;
    const requestValues = Object.fromEntries(op.params.map((param) => [param.name, paramValue(param.name)]));
    const outcome = await runTryIt(op, origin, key, requestValues, fetch);
    setResult(outcome);
    setSending(false);
  }

  return (
    <form onSubmit={send} className="my-6 space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-6">
      <Field id="try-it-key" label="Workspace API key" description="The key is kept in memory only, for this page.">
        <div className="flex gap-2">
          <Input
            type={showKey ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="vxk_..."
          />
          <Button type="button" variant="secondary" size="icon" aria-label={showKey ? "Hide key" : "Show key"} onClick={() => setShowKey((prev) => !prev)}>
            {showKey ? <EyeOff /> : <Eye />}
          </Button>
        </div>
      </Field>

      {op.params.map((param) => (
        <Field key={`${param.in}:${param.name}`} id={`try-it-${param.name}`} label={param.name} optional={!param.required}>
          {param.enum ? (
            <Select value={values[param.name] ?? "any"} onValueChange={(next) => setValues((prev) => ({ ...prev, [param.name]: next }))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">any</SelectItem>
                {param.enum.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={values[param.name] ?? ""}
              onChange={(event) => setValues((prev) => ({ ...prev, [param.name]: event.target.value }))}
              placeholder={param.example !== undefined ? String(param.example) : undefined}
            />
          )}
        </Field>
      ))}

      <Button type="submit" loading={sending}>
        Send
      </Button>

      <TryItResultView result={result} />
    </form>
  );
}
