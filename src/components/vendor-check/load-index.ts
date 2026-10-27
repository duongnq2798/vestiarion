import type { SdnNameSnapshot } from "@/lib/sanctioned-wallets";
import { buildNameIndex, type NameIndex } from "@/lib/vendor-check/match";

/**
 * The vendor check's index (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV7): the SDN name snapshot,
 * loaded when the first check runs, as a separate file of the site's own bundle, and built once. Nothing typed is part
 * of the request, which is the same for everyone. A failed load is tried again at the next check.
 */

let loading: Promise<NameIndex> | null = null;

export function loadNameIndex(): Promise<NameIndex> {
  loading ??= import("@/lib/data/ofac-sdn-names.json")
    .then((snapshot) => buildNameIndex(snapshot.default as unknown as SdnNameSnapshot))
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}
