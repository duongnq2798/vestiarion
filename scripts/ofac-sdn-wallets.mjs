// Makes the two bundled snapshots of OFAC's SDN list from one download, so both carry the same date:
//   src/lib/data/ofac-sdn-evm-wallets.json, the EVM payout addresses (sanctioned wallets SW3), and
//   src/lib/data/ofac-sdn-names.json, every entry's names, programs, countries and addresses (check vendor CV1).
// Download the four files first from the Treasury's Sanctions List Service:
//   https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV
//   https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_COMMENTS.CSV
//   https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ALT.CSV
//   https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADD.CSV
// Usage: npx tsx scripts/ofac-sdn-wallets.mjs <SDN.CSV> <SDN_COMMENTS.CSV> <ALT.CSV> <ADD.CSV> [YYYY-MM-DD]
// It reads them with src/lib/sanctioned-wallets.ts's own parsers, which tsx loads. tests/sanctioned-wallets.test.ts and
// tests/sanctioned-names.test.ts check the snapshots' shape.
import { readFileSync, writeFileSync } from "node:fs";
import { parseSdnNames, parseSdnWallets } from "../src/lib/sanctioned-wallets.ts";

const [sdnPath, commentsPath, altPath, addPath, day] = process.argv.slice(2);
if (!sdnPath || !commentsPath || !altPath || !addPath) {
  console.error("Usage: npx tsx scripts/ofac-sdn-wallets.mjs <SDN.CSV> <SDN_COMMENTS.CSV> <ALT.CSV> <ADD.CSV> [YYYY-MM-DD]");
  process.exit(1);
}

const read = (file) => readFileSync(file, "utf8");
const sdn = read(sdnPath);
const comments = read(commentsPath);
const readAt = `${day ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

const wallets = [...parseSdnWallets(sdn, comments).values()].sort((a, b) => a.address.localeCompare(b.address));
writeFileSync("src/lib/data/ofac-sdn-evm-wallets.json", `${JSON.stringify({ source: "OFAC SDN list", readAt, wallets }, null, 2)}\n`);

// One entry a line, so a refresh shows in review as the entries that changed.
const entries = parseSdnNames({ sdn, comments, alt: read(altPath), add: read(addPath) });
const lines = entries.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n");
writeFileSync("src/lib/data/ofac-sdn-names.json", `{\n  "source": "OFAC SDN list",\n  "readAt": "${readAt}",\n  "entries": [\n${lines}\n  ]\n}\n`);

console.log(`${wallets.length} EVM addresses and ${entries.length} entries, read ${readAt}`);
