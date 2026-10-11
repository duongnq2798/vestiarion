import { describe, expect, it } from "vitest";
import { evidenceShot } from "@/app/docs-shots/evidence-fixture";
import { browserCheckWords } from "@/components/EvidenceBrowserCheck";
import { verifyEntry } from "@/lib/receipts/verify";

/**
 * The evidence page's check in the reader's browser (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E2.9):
 * what it says, and that the guide's screenshot shows it verifying entries that really are signed.
 */

describe("what the browser's check says", () => {
  it("counts the entries while it runs", () => {
    expect(browserCheckWords(6, null)).toEqual({ line: "Checking 6 entries again in your browser…", problems: [] });
    expect(browserCheckWords(1, null).line).toBe("Checking 1 entry again in your browser…");
  });

  it("says every entry verifies, when each does", () => {
    const ok = [41, 42, 43].map((seq) => ({ seq, check: { ok: true } as const }));
    expect(browserCheckWords(3, ok)).toEqual({ line: "Checked again in your browser: all 3 verify.", problems: [] });
    expect(browserCheckWords(1, ok.slice(0, 1)).line).toBe("Checked again in your browser: it verifies.");
  });

  it("names each entry that does not verify, or could not be checked, and never counts it as verified", () => {
    const words = browserCheckWords(3, [
      { seq: 41, check: { ok: true } },
      { seq: 42, check: { ok: false, reason: "The signature does not verify." } },
      { seq: 43, check: { ok: null, reason: "The key that signed this entry is not known here." } },
    ]);
    expect(words.line).toBe("Checked again in your browser: 1 of 3 entries verifies.");
    expect(words.problems).toEqual(["Entry #0042: The signature does not verify.", "Entry #0043: not checked here. The key that signed this entry is not known here."]);
  });
});

describe("the guide's made-up payment", () => {
  it("is signed for real, so its screenshot's check in the browser verifies every entry", async () => {
    const { chain, publicKeys } = evidenceShot();
    expect(chain.entries.length).toBeGreaterThan(4);
    for (const entry of chain.entries) expect(await verifyEntry(entry, publicKeys), `entry ${entry.seq}`).toEqual({ ok: true });
  });

  it("holds every link, each known as the guide says", () => {
    const { chain } = evidenceShot();
    expect(chain.steps.map((step) => [step.id, step.kind])).toEqual([
      ["agreed", "stated"],
      ["delivered", "stated"],
      ["bill", "stated"],
      ["payee", "stated"],
      ["decision", "inferred"],
      ["people", "checked"],
      ["payment", "checked"],
      ["receipt", "checked"],
      ["signatures", "checked"],
    ]);
    expect(chain.steps.find((step) => step.id === "payment")?.facts[0].kind).toBe("verified");
  });
});
