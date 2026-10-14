/**
 * An Asana task's link, read for its ids alone (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A4, A13).
 * A pasted link is never opened: the task's id is taken from it, and the task is read through Asana's API with the
 * workspace's own connection. Only `https://app.asana.com` links read; any other address is not an Asana task. Pure and
 * browser-safe.
 *
 * The forms Asana uses:
 * - `https://app.asana.com/0/<project or 0>/<task>` with an optional `/f`, `/list` or similar after it;
 * - `https://app.asana.com/1/<workspace>/project/<project>/task/<task>`, and `.../1/<workspace>/task/<task>`;
 * - an attachment's permanent link, `https://app.asana.com/app/asana/-/get_asset?asset_id=<attachment>`.
 */

export interface TaskRef {
  taskGid: string;
  projectGid: string | null;
  workspaceGid: string | null;
}

const GID = /^[0-9]{1,32}$/;

function asanaUrl(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1000) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "app.asana.com" || url.port !== "" || url.username !== "" || url.password !== "") return null;
    return url;
  } catch {
    return null;
  }
}

export function taskRefOf(raw: string): TaskRef | null {
  const url = asanaUrl(raw);
  if (!url) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "0" && parts.length >= 3 && GID.test(parts[1]) && GID.test(parts[2])) {
    return { taskGid: parts[2], projectGid: parts[1] === "0" ? null : parts[1], workspaceGid: null };
  }
  if (parts[0] === "1" && parts.length >= 4 && GID.test(parts[1])) {
    const at = parts.lastIndexOf("task");
    const project = parts.indexOf("project");
    if (at > 1 && GID.test(parts[at + 1] ?? "")) {
      return { taskGid: parts[at + 1], projectGid: project > 1 && GID.test(parts[project + 1] ?? "") ? parts[project + 1] : null, workspaceGid: parts[1] };
    }
  }
  return null;
}

/** An attachment's id, from its permanent link; null for anything else. */
export function attachmentGidOf(raw: string): string | null {
  const url = asanaUrl(raw);
  if (!url || url.pathname !== "/app/asana/-/get_asset") return null;
  const id = url.searchParams.get("asset_id");
  return id && GID.test(id) ? id : null;
}
