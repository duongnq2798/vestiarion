// Makes the bundled snapshot of OFAC's sanctioned EVM addresses (src/lib/data/ofac-sdn-evm-wallets.json) from the two
// SDN files, downloaded first from the Treasury's Sanctions List Service:
//   https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV
//   https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_COMMENTS.CSV
// Usage: node scripts/ofac-sdn-wallets.mjs <SDN.CSV> <SDN_COMMENTS.CSV> [YYYY-MM-DD]
// The parsing is the same as src/lib/sanctioned-wallets.ts's parseSdnWallets, which tests/sanctioned-wallets.test.ts
// holds to the snapshot: every address it lists is one the parser finds in the files' format.
import { readFileSync, writeFileSync } from "node:fs";

const [sdnPath, commentsPath, day] = process.argv.slice(2);
if (!sdnPath || !commentsPath) {
  console.error("Usage: node scripts/ofac-sdn-wallets.mjs <SDN.CSV> <SDN_COMMENTS.CSV> [YYYY-MM-DD]");
  process.exit(1);
}

function rowsFromCsv(csv) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

const ADDRESS = /Digital Currency Address - ([A-Z0-9]+) (0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/g;
const overflow = new Map();
for (const [number, text] of rowsFromCsv(readFileSync(commentsPath, "utf8"))) {
  if (!number || text === undefined) continue;
  overflow.set(number.trim(), (overflow.get(number.trim()) ?? "") + text);
}
const wallets = new Map();
for (const row of rowsFromCsv(readFileSync(sdnPath, "utf8"))) {
  const number = row[0]?.trim();
  if (!number) continue;
  const remarks = (row[11] ?? "") + (overflow.get(number) ?? "");
  for (const match of remarks.matchAll(ADDRESS)) {
    const address = match[2].toLowerCase();
    const found = wallets.get(address);
    if (found) {
      if (!found.currencies.includes(match[1])) found.currencies.push(match[1]);
      continue;
    }
    wallets.set(address, { address, entityNumber: number, name: (row[1] ?? "").trim(), currencies: [match[1]] });
  }
}

const list = [...wallets.values()].sort((a, b) => a.address.localeCompare(b.address));
const readAt = `${day ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
writeFileSync("src/lib/data/ofac-sdn-evm-wallets.json", `${JSON.stringify({ source: "OFAC SDN list", readAt, wallets: list }, null, 2)}\n`);
console.log(`${list.length} addresses, read ${readAt}`);
