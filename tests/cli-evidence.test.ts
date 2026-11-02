import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../sdk/src/canonical-json";
import { harness, KEY, recorded, type Harness } from "./support/cli-harness";

/**
 * `vestiarion evidence` and `vestiarion close-pack` (docs/superpowers/specs/2026-11-02-cli-evidence-close-pack-design.md):
 * exports against the API's built examples, which are signed and verify with the key they carry, and offline checks.
 */

const ENV_KEY = { VESTIARION_API_KEY: KEY };
const BILL = "7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4e51";
const MILESTONE = "7d1e4c2a-5b3f-4e8a-9c61-2f0a8b3d4f61";
const ESC = String.fromCharCode(27);

type Doc = Record<string, unknown> & { keys: Array<{ id: string; publicKeyPem: string }>; entries: Array<Record<string, unknown>> };
const example = (name: string) => structuredClone(recorded(name).data) as Doc;
const answer = (data: unknown) => ({ status: 200, body: { data } });

const ROUTES = {
  [`GET /api/v1/invoices/${BILL}/evidence`]: answer(example("get-invoice-evidence")),
  [`GET /api/v1/milestones/${MILESTONE}/evidence`]: answer(example("get-milestone-evidence")),
  [`GET /api/v1/invoices/${BILL}/receipt`]: answer(example("get-invoice-receipt")),
  "GET /api/v1/payee-lock/evidence": answer(example("get-payee-lock-evidence")),
  "GET /api/v1/close-packs/2026-10": answer(example("get-close-pack")),
};

const exporter = (routes: Record<string, unknown> = ROUTES) => harness({ env: ENV_KEY, routes: routes as never });
const fileIn = (h: Harness, name: string) => path.join(h.home, name);
const files = (h: Harness) => readdirSync(h.home).filter((name) => name.endsWith(".json")).sort();
/** Writes a file into the harness's directory and returns its name there. */
function put(h: Harness, name: string, content: string | Buffer): string {
  writeFileSync(fileIn(h, name), content);
  return name;
}
const ed25519Pem = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * Signs one entry again, as the ledger signs, with a new key, and returns that key as a file's key. The entry must be its
 * file's last by seq, so no other entry's prev_hash names it.
 */
function resign(entry: Record<string, unknown>): { id: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const id = sha256(publicKey.export({ type: "spki", format: "der" })).slice(0, 16);
  entry.body_hash = sha256(Buffer.from(canonicalJson({ actor: entry.actor, domain: entry.domain, action: entry.action, summary: entry.summary, detail: entry.detail }), "utf8"));
  entry.signature = sign(null, Buffer.from(String(entry.body_hash), "hex"), privateKey).toString("hex");
  entry.signing_key_id = id;
  entry.hash = sha256(`${String(entry.prev_hash)}${String(entry.body_hash)}${String(entry.signature)}`);
  return { id, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

describe("evidence export and close-pack export (CLI evidence CE1-CE5)", () => {
  it.each([
    [["evidence", "export", "--bill", BILL], `/api/v1/invoices/${BILL}/evidence`, "vestiarion-evidence-northstar-studio-invoice-7d1e4c2a.json", "get-invoice-evidence"],
    [["evidence", "export", "--milestone", MILESTONE], `/api/v1/milestones/${MILESTONE}/evidence`, "vestiarion-evidence-northstar-studio-milestone-7d1e4c2a.json", "get-milestone-evidence"],
    [["evidence", "export", "--receipt", BILL], `/api/v1/invoices/${BILL}/receipt`, "vestiarion-receipt-northstar-studio-7d1e4c2a.json", "get-invoice-receipt"],
    [["evidence", "export", "--payee-lock", "--from", "2026-10-01", "--to", "2026-10-31"], "/api/v1/payee-lock/evidence", "vestiarion-payee-lock-evidence-northstar-studio-2026-10-01-2026-10-31.json", "get-payee-lock-evidence"],
    [["close-pack", "export", "2026-10"], "/api/v1/close-packs/2026-10", "vestiarion-close-pack-northstar-studio-2026-10-so-far.json", "get-close-pack"],
  ])("%j reads %s once and saves the download's text under the download's name", async (argv, route, name, source) => {
    const h = exporter();
    expect(await h.run(...argv)).toBe(0);
    expect(h.sent.map((sent) => `${sent.method} ${new URL(sent.url).pathname}`)).toEqual([`GET ${route}`]);
    expect(files(h)).toEqual([name]);
    // CE2: the text the workspace's Download serves, no newline after it.
    expect(readFileSync(fileIn(h, name), "utf8")).toBe(JSON.stringify(recorded(source).data, null, 2));
    expect(h.stdout).toContain(`Saved ${name} (`);
    expect(h.stdout).toContain("key 36e3209ae2e6a600");
    expect(h.stdout).toContain("Arc testnet:");
    expect(h.stdout).toMatch(/Check it offline: vestiarion (evidence|close-pack) verify /);
    expect(h.stderr).toBe("");
  });

  it("sends the payee lock's period as from and to, and nothing when left out", async () => {
    const h = exporter();
    await h.run("evidence", "export", "--payee-lock", "--from", "2026-10-01");
    expect(Object.fromEntries(new URL(h.sent[0].url).searchParams)).toEqual({ from: "2026-10-01" });
    const all = exporter();
    await all.run("evidence", "export", "--payee-lock", "--out", "all.json");
    expect(new URL(all.sent[0].url).search).toBe("");
  });

  it("says what each file holds: the subject, a receipt's state, the period, the month's totals", async () => {
    const bill = exporter();
    await bill.run("evidence", "export", "--bill", BILL);
    expect(bill.stdout).toContain('the evidence of bill "October catalogue print run" (northstar-studio): Harbor Print Co., 1250 USDC, paid');
    const receipt = exporter();
    await receipt.run("evidence", "export", "--receipt", BILL);
    expect(receipt.stdout).toContain(`the receipt of bill ${BILL} (northstar-studio): ready, 1250 USDC paid 2026-10-03, transaction 0x5171`);
    const pack = exporter();
    await pack.run("close-pack", "export", "2026-10");
    expect(pack.stdout).toContain("the close pack of October 2026 so far (northstar-studio): on chain, 2 payments, 2050.000000 USDC");
    expect(pack.stdout).toContain("11 signed entries");
  });

  it("saves a receipt that is not ready, says why, and exits 0; --json carries ready and notReady", async () => {
    const notReady = { ...example("get-invoice-receipt"), ready: false, notReady: { code: "not_paid", reason: "This invoice is not paid yet." }, facts: null };
    const h = exporter({ [`GET /api/v1/invoices/${BILL}/receipt`]: answer(notReady) });
    expect(await h.run("evidence", "export", "--receipt", BILL)).toBe(0);
    expect(h.stdout).toContain("not ready (not_paid): This invoice is not paid yet.");
    const j = exporter({ [`GET /api/v1/invoices/${BILL}/receipt`]: answer(notReady) });
    expect(await j.run("evidence", "export", "--receipt", BILL, "--json", "--out", "r.json")).toBe(0);
    expect(JSON.parse(j.stdout)).toMatchObject({ file: "r.json", format: "vestiarion-receipt/1", ready: false, notReady: { code: "not_paid" }, entries: 3, keyIds: ["36e3209ae2e6a600"] });
  });

  it("prints the close pack's own warnings: cut and parts not read", async () => {
    const pack = { ...example("get-close-pack"), cut: true, unread: ["screening"] };
    const h = exporter({ "GET /api/v1/close-packs/2026-10": answer(pack) });
    expect(await h.run("close-pack", "export", "2026-10")).toBe(0);
    expect(h.stdout).toContain("more than 2,000 payments");
    expect(h.stdout).toContain("leaves it out: screening.");
    const j = exporter({ "GET /api/v1/close-packs/2026-10": answer(pack) });
    await j.run("close-pack", "export", "2026-10", "--json");
    expect(JSON.parse(j.stdout)).toMatchObject({ cut: true, unread: ["screening"], month: { key: "2026-10", ended: false }, totals: { onChain: [{ token: "USDC" }] } });
  });

  it("writes to --out, prints the document alone with --out -, and leaves no file", async () => {
    const named = exporter();
    expect(await named.run("evidence", "export", "--bill", BILL, "--out", "bill.json")).toBe(0);
    expect(files(named)).toEqual(["bill.json"]);
    const printed = exporter();
    expect(await printed.run("close-pack", "export", "2026-10", "--out", "-")).toBe(0);
    expect(JSON.parse(printed.stdout)).toEqual(recorded("get-close-pack").data);
    expect(printed.stdout).not.toMatch(/[^\x00-\x7f]/);
    expect(printed.stdout.endsWith("}\n")).toBe(true);
    expect(files(printed)).toEqual([]);
  });

  it("never replaces a file without --force: --out is refused before anything is sent (exit 1)", async () => {
    const h = exporter();
    put(h, "bill.json", "mine");
    expect(await h.run("evidence", "export", "--bill", BILL, "--out", "bill.json")).toBe(1);
    expect(h.sent).toEqual([]);
    expect(h.stderr).toContain("bill.json is already there. Pass --force");
    expect(readFileSync(fileIn(h, "bill.json"), "utf8")).toBe("mine");
    expect(await h.run("evidence", "export", "--bill", BILL, "--out", "bill.json", "--force")).toBe(0);
    expect(readFileSync(fileIn(h, "bill.json"), "utf8")).toContain('"format": "vestiarion-evidence/1"');
  });

  it("refuses an --out it cannot write before anything is sent: a missing folder, a folder, a trailing slash (exit 1)", async () => {
    const h = exporter();
    mkdirSync(fileIn(h, "packs"));
    for (const [out, message] of [
      [path.join("no-such-folder", "bill.json"), /is not a folder that is there/],
      ["packs", /packs is a folder\. Name a file in it/],
      ["packs/", /--out names a file/],
    ] as const) {
      expect(await h.run("evidence", "export", "--bill", BILL, "--out", out, "--force")).toBe(1);
      expect(h.stderr).toMatch(message);
    }
    expect(h.sent).toEqual([]);
    expect(files(h)).toEqual([]);
  });

  it("writes a file whole: --force replaces it through a new file, leaving no temporary one", async () => {
    const h = exporter();
    put(h, "bill.json", "mine");
    expect(await h.run("evidence", "export", "--bill", BILL, "--out", "bill.json", "--force")).toBe(0);
    expect(readdirSync(h.home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(fileIn(h, "bill.json"), "utf8")).toBe(JSON.stringify(recorded("get-invoice-evidence").data, null, 2));
  });

  it("checks the download's name only once it is known, and keeps the file there (exit 1)", async () => {
    const h = exporter();
    const name = put(h, "vestiarion-close-pack-northstar-studio-2026-10-so-far.json", "mine");
    expect(await h.run("close-pack", "export", "2026-10")).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.stderr).toContain(`${name} is already there`);
    expect(readFileSync(fileIn(h, name), "utf8")).toBe("mine");
  });

  it("keeps a file name inside the directory, whatever slug the document carries (CE3)", async () => {
    const hostile = { ...example("get-invoice-evidence"), workspace: { slug: "../../evil/..\\x", name: "x" } };
    const h = exporter({ [`GET /api/v1/invoices/${BILL}/evidence`]: answer(hostile) });
    expect(await h.run("evidence", "export", "--bill", BILL)).toBe(0);
    expect(files(h)).toEqual(["vestiarion-evidence-evilx-invoice-7d1e4c2a.json"]);
  });

  it("ends an API refusal, such as a month to come, in exit 2 with the API's message", async () => {
    const h = exporter({ "GET /api/v1/close-packs/2099-01": { status: 400, body: { error: { code: "invalid_request", message: "month must be YYYY-MM, and not a month still to come" } } } });
    expect(await h.run("close-pack", "export", "2099-01")).toBe(2);
    expect(h.stderr).toContain("month must be YYYY-MM, and not a month still to come (HTTP 400 invalid_request)");
    expect(files(h)).toEqual([]);
  });

  it("prints --out - as ASCII, so a shell that re-encodes it, as PowerShell 5.1's > does, cannot change a signed name", async () => {
    const doc = example("get-invoice-evidence");
    const last = doc.entries.reduce((a, b) => (Number(a.seq) > Number(b.seq) ? a : b));
    last.summary = `Paid Imprimerie Caf${String.fromCharCode(0xe9)} ${String.fromCharCode(0x2014)} Lumi${String.fromCharCode(0xe8)}re`;
    doc.keys.push(resign(last));
    const h = exporter({ [`GET /api/v1/invoices/${BILL}/evidence`]: answer(doc) });
    expect(await h.run("evidence", "export", "--bill", BILL, "--out", "-", "--json")).toBe(0);
    expect(h.stdout).not.toMatch(/[^\x00-\x7f]/);
    expect(JSON.parse(h.stdout)).toEqual(doc);
    // What Windows PowerShell 5.1's > writes: UTF-16 with a byte-order mark.
    put(h, "captured.json", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(h.stdout, "utf16le")]));
    const before = h.stdout.length;
    expect(await h.run("evidence", "verify", "captured.json")).toBe(0);
    expect(h.stdout.slice(before)).toMatch(/^VALID: /);
    // Saved with --out, the file keeps the download's UTF-8 text.
    expect(await h.run("evidence", "export", "--bill", BILL, "--out", "saved.json")).toBe(0);
    expect(readFileSync(fileIn(h, "saved.json"), "utf8")).toContain(`Imprimerie Caf${String.fromCharCode(0xe9)}`);
  });

  it("says what a payee lock's file holds", async () => {
    const h = exporter();
    expect(await h.run("evidence", "export", "--payee-lock", "--from", "2026-10-01", "--to", "2026-10-31")).toBe(0);
    expect(h.stdout).toContain("the payee lock's evidence for 2026-10-01 to 2026-10-31 (northstar-studio): 1 address change");
  });

  it("writes no file when the API answers an error (exit 2), with its message", async () => {
    const h = exporter({ [`GET /api/v1/invoices/${BILL}/evidence`]: { status: 404, body: { error: { code: "not_found", message: `Payable invoice "${BILL}" was not found.` } } } });
    expect(await h.run("evidence", "export", "--bill", BILL)).toBe(2);
    expect(h.stderr).toContain("was not found. (HTTP 404 not_found)");
    expect(files(h)).toEqual([]);
  });

  it.each([
    [["evidence", "export"], /Pass exactly one of --bill, --milestone, --receipt and --payee-lock/],
    [["evidence", "export", "--bill", BILL, "--payee-lock"], /Pass exactly one of/],
    [["evidence", "export", "--bill", BILL, "--from", "2026-10-01"], /--from and --to go with --payee-lock/],
    [["evidence", "export", "--payee-lock", "--from", "Oct 1"], /--from is a day, as YYYY-MM-DD/],
    [["evidence", "export", "--payee-lock", "--to", "2026-10"], /--to is a day/],
    [["evidence", "export", "--bill", " "], /--bill is required/],
    [["evidence", "export", "--bill", BILL, "--out", ""], /--out names a file/],
    [["close-pack", "export", "2026-1"], /<YYYY-MM> is a month/],
    [["close-pack", "export", "October"], /<YYYY-MM> is a month/],
    [["close-pack", "export"], /takes <YYYY-MM>/],
    [["evidence", "export", "--bill", "first", "--bill", BILL], /--bill was given more than once/],
  ])("refuses %j as a usage error (exit 1), sending nothing (CE4)", async (argv, message) => {
    const h = exporter();
    expect(await h.run(...argv)).toBe(1);
    expect(h.stderr).toMatch(message);
    expect(h.sent).toEqual([]);
  });

  it("takes out the control characters of outside text before printing it (CE8)", async () => {
    const doc = example("get-invoice-evidence");
    doc.subject = { ...(doc.subject as object), title: `Print run${ESC}[2J${ESC}]0;owned${String.fromCharCode(7)}`, payee: `Harbor${String.fromCharCode(0x9b)}31m Co.` };
    const h = exporter({ [`GET /api/v1/invoices/${BILL}/evidence`]: answer(doc) });
    expect(await h.run("evidence", "export", "--bill", BILL)).toBe(0);
    expect(h.stdout).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    expect(h.stdout).toContain('"Print run [2J ]0;owned"');
  });
});

describe("evidence verify and close-pack verify (CE6, CE7)", () => {
  /** A harness with each example saved as its own file, as an export saves it. */
  function withFiles() {
    const h = harness();
    for (const name of ["get-invoice-evidence", "get-milestone-evidence", "get-invoice-receipt", "get-payee-lock-evidence", "get-close-pack"]) {
      put(h, `${name}.json`, JSON.stringify(recorded(name).data, null, 2));
    }
    put(h, "key.pem", example("get-close-pack").keys[0].publicKeyPem);
    return h;
  }

  it.each(["get-invoice-evidence", "get-milestone-evidence", "get-invoice-receipt", "get-payee-lock-evidence", "get-close-pack"])(
    "finds %s VALID with the workspace's key and with its own, sending nothing and needing no key",
    async (name) => {
      const h = withFiles();
      expect(await h.run("evidence", "verify", `${name}.json`, "--public-key", "key.pem")).toBe(0);
      expect(h.stdout).toMatch(/^VALID: the /);
      expect(h.stdout).toContain("Signed by key 36e3209ae2e6a600; checked with the keys from --public-key");
      expect(h.stdout).not.toContain("Checked with the keys the document carries");
      const own = withFiles();
      expect(await own.run("evidence", "verify", `${name}.json`)).toBe(0);
      expect(own.stdout).toContain("Signed by key 36e3209ae2e6a600; checked with the keys the file carries");
      expect(own.stdout).toContain("Checked with the keys the document carries");
      expect([...h.sent, ...own.sent]).toEqual([]);
    }
  );

  it("gives the same answer for a file minified, or indented by an editor, and says only the entries are signed", async () => {
    const h = withFiles();
    const data = recorded("get-close-pack").data;
    put(h, "minified.json", JSON.stringify(data));
    put(h, "indented.json", JSON.stringify(data, null, 4).replace(/\n/g, "\r\n"));
    for (const file of ["minified.json", "indented.json"]) {
      expect(await h.run("close-pack", "verify", file, "--public-key", "key.pem")).toBe(0);
    }
    expect(h.stdout).toContain("Only the entries are signed: the file's own words around them, such as its name for what it is of, are not.");
  });

  it("names the key the entries ask for beside the one given, on one line for all the entries it leaves unchecked", async () => {
    const h = withFiles();
    put(h, "other.pem", ed25519Pem());
    expect(await h.run("close-pack", "verify", "get-close-pack.json", "--public-key", "other.pem")).toBe(2);
    expect(h.stdout).toMatch(/^NOT CHECKED: the close pack/);
    expect(h.stdout).toMatch(/The entries not checked name key 36e3209ae2e6a600; the keys given are [0-9a-f]{16}\./);
    expect(h.stdout).toMatch(/- Entries #\d+(, #\d+){9} and 1 more could not be checked: The key that signed this entry is not known here\./);
    expect(h.stdout.match(/could not be checked/g)).toHaveLength(1);
  });

  it("checks what an export saved: the round trip is VALID", async () => {
    const h = exporter();
    await h.run("close-pack", "export", "2026-10", "--out", "october.json");
    const before = h.stdout.length;
    expect(await h.run("close-pack", "verify", "october.json")).toBe(0);
    expect(h.stdout.slice(before)).toMatch(/^VALID: the close pack of October 2026 so far \(northstar-studio\)/);
  });

  it("prints a close pack's totals and ledger head as the file's own words, and how to tie it to the whole ledger", async () => {
    const h = withFiles();
    expect(await h.run("close-pack", "verify", "get-close-pack.json", "--public-key", "key.pem")).toBe(0);
    expect(h.stdout).toContain("Entries: 11 carried, 11 verified, 0 failed, 0 not checked; 11 cited");
    expect(h.stdout).toContain("The file states, outside the signatures: on chain, 2 payments, 2050.000000 USDC; the ledger's head when read, #5618 d24bfd6b");
    expect(h.stdout).toContain("vestiarion ledger verify");
    expect(h.stdout).toContain("Not checked offline:");
  });

  it("says a file with no signed entry has nothing signed, whatever totals it states", async () => {
    const h = withFiles();
    const empty = { ...example("get-close-pack"), rows: [], notSettled: [], escrow: [], entries: [], totals: { onChain: [{ token: "USDC", payments: 99, amount: "1000000.000000", routeFeesUsdc: "0.000000" }] } };
    put(h, "empty.json", JSON.stringify(empty));
    expect(await h.run("close-pack", "verify", "empty.json", "--public-key", "key.pem")).toBe(0);
    expect(h.stdout).toContain("The file carries no signed entry, so nothing in it is signed.");
    expect(h.stdout).toContain("The file states, outside the signatures: on chain, 99 payments, 1000000.000000 USDC");
  });

  it("names the key that signed each entry, not the ids the file lists (CE6)", async () => {
    const h = withFiles();
    // Re-signed with another key, which the file carries beside the workspace's: the entries still verify, by that key.
    const doc = example("get-invoice-receipt");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const otherId = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
    const hex = (text: string) => createHash("sha256").update(text).digest("hex");
    for (const entry of doc.entries) {
      entry.signature = sign(null, Buffer.from(String(entry.body_hash), "hex"), privateKey).toString("hex");
      entry.signing_key_id = otherId;
      entry.hash = hex(`${String(entry.prev_hash)}${String(entry.body_hash)}${String(entry.signature)}`);
    }
    // The receipt names its recording entry by hash: that copy follows the entry.
    const records = doc.records as { seq: number; hash: string };
    records.hash = String(doc.entries.find((entry) => entry.seq === records.seq)?.hash);
    doc.keys.push({ id: otherId, publicKeyPem: pem });
    put(h, "resigned.json", JSON.stringify(doc));
    expect(await h.run("evidence", "verify", "resigned.json")).toBe(0);
    expect(h.stdout).toContain(`Signed by key ${otherId}; checked with the keys the file carries`);
    expect(h.stdout).not.toContain("36e3209ae2e6a600");
    // Against the workspace's key, it is not the workspace's.
    expect(await h.run("evidence", "verify", "resigned.json", "--public-key", "key.pem")).toBe(2);
  });

  it("finds a key filed under another key's id BROKEN, though the SDK never uses it", async () => {
    const h = withFiles();
    const doc = example("get-invoice-receipt");
    doc.keys.push({ id: "0123456789abcdef", publicKeyPem: ed25519Pem() });
    put(h, "misfiled.json", JSON.stringify(doc));
    expect(await h.run("evidence", "verify", "misfiled.json", "--json")).toBe(2);
    const answer = JSON.parse(h.stdout);
    expect(answer).toMatchObject({ verdict: "broken", ok: false });
    expect(answer.problems.at(-1)).toMatch(/^The file files a key under 0123456789abcdef, but that key's id is [0-9a-f]{16}\.$/);
  });

  it("never prints the control characters a file holds, a JSON error quoting them included (CE8)", async () => {
    const h = withFiles();
    put(h, "esc.json", `x\r${ESC}[2K${ESC}[32mVALID${ESC}[8m`);
    put(h, "export.json", `x\r${ESC}[2K${ESC}[32mVALID${ESC}[8m`);
    expect(await h.run("evidence", "verify", "esc.json")).toBe(2);
    expect(await h.run("ledger", "verify", "export.json")).toBe(2);
    expect(h.stdout).toMatch(/^NOT CHECKED: esc\.json could not be read as JSON/);
    expect(h.stdout).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  });

  it("finds a big-endian UTF-16 file with an odd byte NOT CHECKED, with a verdict", async () => {
    const h = withFiles();
    put(h, "odd.json", Buffer.from([0xfe, 0xff, 0x00, 0x7b, 0x00]));
    expect(await h.run("evidence", "verify", "odd.json", "--json")).toBe(2);
    expect(JSON.parse(h.stdout)).toMatchObject({ verdict: "not_checked", reason: "odd.json could not be read as UTF-16: it has an odd number of bytes" });
  });

  it("finds a changed entry BROKEN (exit 2), naming it", async () => {
    const h = withFiles();
    const doc = example("get-invoice-evidence");
    doc.entries[0].summary = `${String(doc.entries[0].summary)} (edited)`;
    put(h, "edited.json", JSON.stringify(doc));
    expect(await h.run("evidence", "verify", "edited.json", "--public-key", "key.pem")).toBe(2);
    expect(h.stdout).toMatch(/^BROKEN: the evidence of bill/);
    expect(h.stdout).toContain(`- Entry #${doc.entries[0].seq} does not verify: The entry's content does not match its body hash.`);
  });

  it("finds a close pack row whose cited entry was taken out BROKEN", async () => {
    const h = withFiles();
    const doc = example("get-close-pack");
    const cited = (doc.rows as Array<{ record: { seq: number } }>)[0].record.seq;
    doc.entries = doc.entries.filter((entry) => entry.seq !== cited);
    put(h, "short.json", JSON.stringify(doc));
    expect(await h.run("close-pack", "verify", "short.json")).toBe(2);
    expect(h.stdout).toContain(`- Entry #${cited} is cited but not in the document.`);
  });

  it("is NOT CHECKED (exit 2) against a key that did not sign it, and VALID once every key is given", async () => {
    const h = withFiles();
    put(h, "other.pem", ed25519Pem());
    expect(await h.run("evidence", "verify", "get-invoice-receipt.json", "--public-key", "other.pem")).toBe(2);
    expect(h.stdout).toMatch(/^NOT CHECKED: the receipt of bill/);
    expect(h.stdout).toContain("could not be checked");
    const both = withFiles();
    put(both, "other.pem", ed25519Pem());
    expect(await both.run("evidence", "verify", "get-invoice-receipt.json", "--public-key", "other.pem", "--public-key", "key.pem")).toBe(0);
    const bundle = withFiles();
    put(bundle, "both.pem", `${ed25519Pem()}\n${example("get-close-pack").keys[0].publicKeyPem}`);
    expect(await bundle.run("evidence", "verify", "get-invoice-receipt.json", "--public-key", "both.pem")).toBe(0);
    expect(bundle.stdout).toContain("Signed by key 36e3209ae2e6a600; checked with the keys from --public-key");
  });

  it.each([
    ["a private key", () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(), /holds a private key/],
    ["an RSA key", () => generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }).toString(), /holds a rsa key; the ledger's keys are Ed25519/],
    ["no key", () => "not a key", /holds no PEM key block/],
    ["a block that is not a key", () => "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n", /a public key in .* could not be read/],
  ])("refuses %s as --public-key: NOT CHECKED (exit 2)", async (_, pem, message) => {
    const h = withFiles();
    put(h, "given.pem", pem());
    expect(await h.run("evidence", "verify", "get-invoice-receipt.json", "--public-key", "given.pem")).toBe(2);
    expect(h.stdout).toMatch(/^NOT CHECKED: /);
    expect(h.stdout).toMatch(message);
  });

  it.each([
    ["a missing file", null, /missing\.json could not be read/],
    ["a file that is not JSON", "{ nope", /could not be read as JSON/],
    ["an audit export", JSON.stringify({ format: "vestiarion-ledger-export/1", entries: [], keys: [] }), /is not a Vestiarion evidence file/],
    ["an object of no format", JSON.stringify({ data: { entries: [] } }), /is not a Vestiarion evidence file/],
  ])("finds %s NOT CHECKED (exit 2), naming the file as given", async (_, content, message) => {
    const h = withFiles();
    if (content !== null) put(h, "missing.json", content);
    expect(await h.run("evidence", "verify", "missing.json")).toBe(2);
    expect(h.stdout).toMatch(/^NOT CHECKED: missing\.json /);
    expect(h.stdout).toMatch(message);
  });

  it("checks a close pack only with close-pack verify", async () => {
    const h = withFiles();
    expect(await h.run("close-pack", "verify", "get-invoice-evidence.json")).toBe(2);
    expect(h.stdout).toBe("NOT CHECKED: get-invoice-evidence.json is a vestiarion-evidence/1 file, not a close pack (vestiarion-close-pack/1)\n");
  });

  it("reads a file saved by Windows PowerShell's >, UTF-16 with a byte-order mark, and UTF-8 with one", async () => {
    const h = withFiles();
    const text = JSON.stringify(recorded("get-payee-lock-evidence").data, null, 2);
    put(h, "utf16.json", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    put(h, "utf8bom.json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]));
    expect(await h.run("evidence", "verify", "utf16.json", "--public-key", "key.pem")).toBe(0);
    expect(await h.run("evidence", "verify", "utf8bom.json", "--public-key", "key.pem")).toBe(0);
  });

  it("reads an API answer's data, and says so", async () => {
    const h = withFiles();
    put(h, "answer.json", JSON.stringify(recorded("get-close-pack")));
    expect(await h.run("close-pack", "verify", "answer.json", "--public-key", "key.pem")).toBe(0);
    expect(h.stdout).toContain("The file is an API answer: its data was checked.");
  });

  it("answers --json with the SDK's verification, the verdict and where the keys came from", async () => {
    const h = withFiles();
    expect(await h.run("evidence", "verify", "get-invoice-evidence.json", "--public-key", "key.pem", "--json")).toBe(0);
    expect(JSON.parse(h.stdout)).toMatchObject({
      verdict: "valid",
      file: "get-invoice-evidence.json",
      unwrapped: false,
      keySource: "--public-key",
      signedBy: ["36e3209ae2e6a600"],
      ok: true,
      format: "vestiarion-evidence/1",
      keys: "given",
      counts: { carried: 7, verified: 7, failed: 0, unchecked: 0 },
      problems: [],
    });
    const missing = withFiles();
    expect(await missing.run("evidence", "verify", "nope.json", "--json")).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({ verdict: "not_checked", file: "nope.json", ok: null, counts: { carried: 0, failed: 0 }, signedBy: [], keySource: "file" });
    expect(JSON.parse(missing.stdout).problems).toEqual([JSON.parse(missing.stdout).reason]);
  });
});
