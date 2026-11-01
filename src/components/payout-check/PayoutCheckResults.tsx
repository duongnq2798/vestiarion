import { ArrowLeft, CirclePause, CircleX, Download, Info, OctagonX, RotateCcw, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getAddress } from "viem";
import { Marked } from "@/components/address-check/AddressChecker";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Disclosure } from "@/components/ui/Disclosure";
import { TOKEN_CONTRACTS } from "@/lib/address-check";
import { groupedDecimal } from "@/lib/connectors/crm";
import { plural } from "@/lib/copy";
import {
  rowWords,
  tokenLabel,
  VERDICT_WORDS,
  type FindingLevel,
  type PayoutCheck,
  type PayoutFinding,
  type PayoutResult,
  type PayoutTokenUse,
} from "@/lib/payout-check/findings";
import { PAYOUT_ROWS_MAX } from "@/lib/payout-check/read";

/**
 * What the free payout batch check found (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP6-CP9): the
 * summary the page announces, with the counts and the OFAC list's date; the totals per token; each token a check found
 * something on, said once with the rows that pay it; then the rows with a finding in batch order, each with its address,
 * the digits a lookalike pair shares marked, its amount, its token and every finding in words; and the rows with nothing
 * found, folded, and drawn only once they are opened. A row with nothing found is told just that, never more (CP8).
 */

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${plural(n, one, many)}`;
const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** At most this many rows of a list are drawn at first, so a batch of thousands stays quick; the rest are a press away, and all are in the download. */
const ROWS_SHOWN = 200;

/** Narrower padding on a phone, so a pair of marked addresses keeps each on one line at 375 px. */
const CARD = "rounded-xl border border-line bg-surface px-3 py-3 sm:px-4";

/** Each level in words, with its own shape beside its colour (CP9): refused for fix and stop, attention for look. */
const LEVELS: Record<FindingLevel, { word: string; Icon: LucideIcon; color: string }> = {
  fix: { word: VERDICT_WORDS.fix, Icon: CircleX, color: "text-refused" },
  stop: { word: VERDICT_WORDS.stop, Icon: OctagonX, color: "text-refused" },
  look: { word: VERDICT_WORDS.look, Icon: CirclePause, color: "text-held" },
  note: { word: "Note", Icon: Info, color: "text-ink-3" },
};

const levelTone = (level: FindingLevel) => (level === "fix" || level === "stop" ? "refused" : level === "look" ? "held" : "neutral");

/** What a row says of a token a check found something on: the token's own finding is said once, under Tokens with a finding (CP7). */
const TOKEN_POINTER = "A token this page does not know: its contract is under Tokens with a finding, above.";

/**
 * The headline and the counts under it (CP9): the one part announced when the check runs. It says what each row was
 * compared with, whether the amounts were read, any rows left out and the OFAC list's date (CP1, CP5, CP6).
 */
export function PayoutCheckSummary({ result, listDate }: { result: PayoutCheck; listDate: string }) {
  const { counts } = result;
  const blocked = counts.fix + counts.stop;
  const total = counts.rows + result.leftOut;
  const title =
    blocked > 0 ? "Do not send this batch as it is" : counts.look > 0 ? `Look at ${count(counts.look, "row", "rows")} before you send this batch` : "Nothing found";
  const parts = [
    counts.rows === total ? `Checked ${count(total, "row", "rows")}.` : `Checked ${counts.rows.toLocaleString("en-US")} of ${count(total, "row", "rows")}.`,
    blocked + counts.look === 0 ? "None of these checks found anything. Nothing here says whose an address is: before a first payment to one, confirm it with the payee." : null,
    result.known === 0
      ? "The batch was compared only with itself: add the addresses you have paid before to compare each row with them too."
      : `Each row was compared with the rest of the batch and with the ${count(result.known, "address", "addresses")} you have paid before.`,
    result.amounts ? null : "The batch has no amount column, so its addresses alone were checked.",
    result.leftOut > 0 ? `Only the first ${PAYOUT_ROWS_MAX.toLocaleString("en-US")} rows were checked: ${count(result.leftOut, "row was", "rows were")} left out.` : null,
    `OFAC's SDN list as of ${listDate}.`,
  ];
  const tiles: Array<{ label: string; value: number; color: string }> = [
    { label: "Rows read", value: counts.rows, color: "text-ink" },
    { label: "To fix", value: counts.fix, color: counts.fix > 0 ? "text-refused" : "text-ink" },
    { label: "To stop", value: counts.stop, color: counts.stop > 0 ? "text-refused" : "text-ink" },
    { label: "To look at", value: counts.look, color: counts.look > 0 ? "text-held" : "text-ink" },
    { label: "Nothing found", value: counts.nothingFound, color: "text-ink" },
  ];
  return (
    <div className="space-y-3">
      <Callout tone={blocked > 0 ? "refused" : counts.look > 0 ? "held" : "neutral"} title={title}>
        {parts.filter(Boolean).join(" ")}
      </Callout>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {tiles.map((tile) => (
          <div key={tile.label} className="min-w-0 rounded-xl border border-line bg-surface px-3 py-2">
            <dt className="text-xs text-ink-3">{tile.label}</dt>
            <dd className={`mt-0.5 text-lg font-semibold tabular-nums ${tile.color}`}>{tile.value.toLocaleString("en-US")}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ResultSection({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <h2 id={id} className="text-base font-semibold tracking-[-0.01em] text-ink">
          {title}
        </h2>
        {intro && <p className="mt-1 text-sm leading-relaxed text-ink-3">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

/** A known token's contract by its name, checksummed, to set beside one made to look like it. */
function tokenContract(label: string): string | null {
  const found = TOKEN_CONTRACTS.find((token) => token.label === label);
  return found ? getAddress(found.address) : null;
}

/** How a pair's digits are marked, in words for the ends they share: both, or only one (CP9). */
function markedWords(leading: number, trailing: number): string {
  if (leading > 0 && trailing > 0) return "The digits they share at each end are underlined; the digits between them that differ are bold.";
  return leading > 0
    ? "The first digits they share are underlined; the digits after them that differ are bold."
    : "The last digits they share are underlined; the digits before them that differ are bold.";
}

/** Two addresses, one above the other, their shared ends underlined and the digits between that differ bold (CP9). */
function Pair({ first, firstLabel, second, secondLabel, leading, trailing }: { first: string; firstLabel: string; second: string; secondLabel: string; leading: number; trailing: number }) {
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface px-3 py-3 sm:px-3.5">
      <div className="min-w-0">
        <p className="text-xs font-medium text-ink-3 [overflow-wrap:anywhere]">{firstLabel}</p>
        <Marked address={first} other={second} leading={leading} trailing={trailing} />
      </div>
      <div className="min-w-0">
        <p className="break-words text-xs font-medium text-ink-3">{secondLabel}</p>
        <Marked address={second} other={first} leading={leading} trailing={trailing} />
      </div>
      <p className="text-xs leading-relaxed text-ink-3">{markedWords(leading, trailing)}</p>
    </div>
  );
}

/** A token a check found something on, said once, with the rows that pay it (CP7). */
function TokenCard({ use }: { use: PayoutTokenUse }) {
  const finding = use.finding!;
  const { word } = LEVELS[finding.level];
  const real = use.token.kind === "contract" && use.token.like ? tokenContract(use.token.like.label) : null;
  return (
    <li className={`${CARD} space-y-2`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-all font-mono text-xs leading-6 text-ink">{use.label || "No token named"}</p>
        <Badge tone={levelTone(finding.level)} size="sm">
          {word}
        </Badge>
      </div>
      <p className="break-words text-sm leading-relaxed text-ink-2">{finding.text}</p>
      {real && use.token.kind === "contract" && use.token.like && (
        <Pair
          first={use.token.checksummed}
          firstLabel="The token contract in the batch"
          second={real}
          secondLabel={`${use.token.like.label}'s contract`}
          leading={use.token.like.leading}
          trailing={use.token.like.trailing}
        />
      )}
      <p className="text-xs text-ink-3">{`${capitalized(rowWords(use.lines))} ${use.lines.length === 1 ? "pays" : "pay"} it.`}</p>
    </li>
  );
}

/**
 * A row's address as the batch gives it: checksummed when it is one, as written when it is not or when the address was
 * read from a longer cell (after a chain prefix or in a payment link), whose note says what was read; and beside the
 * address it is made to look like (CP9).
 */
function RowAddress({ result, byLine }: { result: PayoutResult; byLine: ReadonlyMap<number, PayoutResult> }) {
  const { address, row } = result;
  if (address.kind === "empty") return <p className="text-sm text-ink-3">No address.</p>;
  const asWritten = <p className="break-all font-mono text-xs leading-6 text-ink-2">{row.address}</p>;
  if (address.kind !== "evm" || !address.check.format.ok) return asWritten;
  const own = address.check.checksummed!;
  const ownLabel = address.read === null ? "This row's address" : `This row's address, read from ${row.address}`;
  // One comparison: a row made to look like this one first, then an address paid before, then 4 digits shared.
  const rowAlike = result.pairs.find((pair) => pair.alike);
  const knownAlike = address.check.matches.find((match) => match.kind === "alike");
  const rowPartial = result.pairs.find((pair) => !pair.alike);
  const knownPartial = address.check.matches.find((match) => match.kind === "partial");
  const rowPair = rowAlike ?? (knownAlike ? undefined : rowPartial);
  if (rowPair) {
    const other = byLine.get(rowPair.lines[0]);
    const otherAddress = other?.address.kind === "evm" && other.address.check.checksummed ? other.address.check.checksummed : rowPair.address;
    return (
      <Pair
        first={own}
        firstLabel={ownLabel}
        second={otherAddress}
        secondLabel={`${capitalized(rowWords(rowPair.lines))}${rowPair.name ? `, ${rowPair.name}` : ""}`}
        leading={rowPair.leading}
        trailing={rowPair.trailing}
      />
    );
  }
  const known = knownAlike ?? knownPartial;
  if (known) {
    return (
      <Pair
        first={own}
        firstLabel={ownLabel}
        second={getAddress(known.known.address)}
        secondLabel={`${known.known.label}, paid before`}
        leading={known.leading}
        trailing={known.trailing}
      />
    );
  }
  return address.read === null ? <p className="break-all font-mono text-xs leading-6 text-ink-2">{own}</p> : asWritten;
}

function FindingLine({ finding }: { finding: PayoutFinding }) {
  const { word, Icon, color } = LEVELS[finding.level];
  return (
    <li className="flex gap-2 text-sm leading-relaxed text-ink-2">
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${color}`} />
      <span className="min-w-0 break-words">
        <span className="font-semibold text-ink">{word}:</span> {finding.kind === "token_unknown" ? TOKEN_POINTER : finding.text}
      </span>
    </li>
  );
}

/**
 * A row with a finding (CP9): its line, name, verdict, address, amount and token, and each finding in words. `focusable`
 * lets the list move the focus to it, as the first of the rows a press drew.
 */
function RowCard({ result, byLine, focusable }: { result: PayoutResult; byLine: ReadonlyMap<number, PayoutResult>; focusable: boolean }) {
  const { row, verdict } = result;
  const token = tokenLabel(result.token);
  return (
    <li tabIndex={focusable ? -1 : undefined} className="space-y-3 rounded-2xl border border-line px-3 py-4 sm:px-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-words text-sm">
          <span className="font-semibold text-ink">{`Row ${row.line}`}</span>
          {row.name && <span className="text-ink-2">{` · ${row.name}`}</span>}
        </p>
        <Badge tone={verdict === "nothing_found" ? "neutral" : levelTone(verdict)} size="sm">
          {VERDICT_WORDS[verdict]}
        </Badge>
      </div>
      <RowAddress result={result} byLine={byLine} />
      {(result.amount !== null || token !== "") && (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {result.amount !== null && (
            <div className="flex min-w-0 gap-1.5">
              <dt className="text-ink-3">Amount</dt>
              <dd className="min-w-0 break-all font-mono text-ink">{row.amount || "none"}</dd>
            </div>
          )}
          {token !== "" && (
            <div className="flex min-w-0 gap-1.5">
              <dt className="text-ink-3">Token</dt>
              <dd className="min-w-0 break-all text-ink">{token}</dd>
            </div>
          )}
        </dl>
      )}
      <ul className="space-y-1.5">
        {result.findings.map((finding, index) => (
          <FindingLine key={`${finding.kind}-${index}`} finding={finding} />
        ))}
      </ul>
    </li>
  );
}

/**
 * A row with nothing found, in one line, with any note: the address paid before, or the part of the cell read, after
 * the cell as written (CP9).
 */
function QuietRow({ result, focusable }: { result: PayoutResult; focusable: boolean }) {
  const { row, address } = result;
  const shown = address.kind === "evm" && address.read === null && address.check.checksummed ? address.check.checksummed : row.address;
  const token = tokenLabel(result.token);
  const notes = result.findings.filter((finding) => finding.level === "note");
  return (
    <li tabIndex={focusable ? -1 : undefined} className="min-w-0 break-words text-sm leading-relaxed text-ink-2">
      <span className="text-ink">{`Row ${row.line}`}</span>
      {row.name && ` · ${row.name}`}
      {result.amount !== null && row.amount && ` · ${row.amount}${token ? ` ${token}` : ""}`}
      {" · "}
      <span className="break-all font-mono text-xs text-ink-3">{shown}</span>
      {notes.map((note) => ` ${note.text}`).join("")}
    </li>
  );
}

/**
 * A list drawn `ROWS_SHOWN` items at a time, so a batch of thousands stays quick (CP9). A press draws the next ones and
 * moves the focus to the first of them: the button goes once every item is drawn, and the focus with it would fall to
 * the page. `what` ends the sentence saying how many are shown.
 */
function Paged<T>({
  items,
  what,
  className,
  children,
}: {
  items: readonly T[];
  what: string;
  className: string;
  children: (item: T, focusable: boolean) => ReactNode;
}) {
  const [shown, setShown] = useState(ROWS_SHOWN);
  const [first, setFirst] = useState<number | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (first !== null) (list.current?.children[first] as HTMLElement | undefined)?.focus();
  }, [first]);
  const more = Math.min(ROWS_SHOWN, items.length - shown);
  return (
    <div className="space-y-3">
      <ul ref={list} className={className}>
        {items.slice(0, shown).map((item, index) => children(item, index === first))}
      </ul>
      {more > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-sm text-ink-3">{`Showing ${shown.toLocaleString("en-US")} of ${count(items.length, "row", "rows")} ${what}. The download has every row.`}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setFirst(shown);
              setShown(shown + ROWS_SHOWN);
            }}
          >
            {`Show ${more.toLocaleString("en-US")} more`}
          </Button>
        </div>
      )}
    </div>
  );
}

export function PayoutCheckResults({
  result,
  onBack,
  onRestart,
  onDownload,
}: {
  result: PayoutCheck;
  onBack: () => void;
  onRestart: () => void;
  onDownload: () => void;
}) {
  // The rows with nothing found are drawn once they are first opened, not while they wait folded (CP9).
  const [quietOpened, setQuietOpened] = useState(false);
  const { byLine, flagged, quiet, tokens } = useMemo(
    () => ({
      byLine: new Map(result.results.map((each) => [each.row.line, each] as const)),
      flagged: result.results.filter((each) => each.verdict !== "nothing_found"),
      quiet: result.results.filter((each) => each.verdict === "nothing_found"),
      tokens: result.tokens.filter((use) => use.finding !== null),
    }),
    [result]
  );

  return (
    <div className="space-y-8">
      <ResultSection id="check-payouts-totals" title="Totals" intro="Each token's amounts added up exactly, the token named as the batch names it. Nothing is converted.">
        {!result.amounts ? (
          <p className="text-sm text-ink-2">The batch has no amount column, so there is nothing to total.</p>
        ) : (
          <div className="space-y-3">
            {result.totals.length > 1 && (
              <Callout tone="held" title="More than one token">
                {`This batch pays ${result.totals.length} tokens. Check that each row pays the one you mean.`}
              </Callout>
            )}
            {result.totals.length === 0 ? (
              result.notTotalled > 0 && <p className="text-sm text-ink-2">No amount in the batch could be read.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {result.totals.map((total) => (
                  <li key={total.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
                    <p className="min-w-0 text-sm">
                      <span className="break-all font-medium text-ink">{total.label || "No token named"}</span>
                      <span className="text-ink-3">{` · ${count(total.rows, "row", "rows")}`}</span>
                    </p>
                    <p className="break-all font-mono text-sm tabular-nums text-ink">{groupedDecimal(total.sum)}</p>
                  </li>
                ))}
              </ul>
            )}
            {result.notTotalled > 0 && (
              <p className="text-xs leading-relaxed text-ink-3">
                {`${count(result.notTotalled, "row", "rows")} with an amount or a token to fix ${result.notTotalled === 1 ? "is" : "are"} left out of the totals.`}
              </p>
            )}
            {result.nftRows > 0 && (
              <p className="text-xs leading-relaxed text-ink-3">
                {`${count(result.nftRows, "NFT row is", "NFT rows are")} not totalled: an NFT row's amount is not read.`}
              </p>
            )}
          </div>
        )}
      </ResultSection>

      {tokens.length > 0 && (
        <ResultSection id="check-payouts-tokens" title="Tokens with a finding" intro="Each token a check found something on, said once, with the rows that pay it.">
          <ul className="space-y-2">
            {tokens.map((use) => (
              <TokenCard key={use.key} use={use} />
            ))}
          </ul>
        </ResultSection>
      )}

      <ResultSection
        id="check-payouts-rows"
        title="Rows with a finding"
        intro="In batch order. Fix: it cannot be sent as written. Stop: do not send it until it is checked. Look: send it only after a look."
      >
        {flagged.length === 0 ? (
          <p className="text-sm text-ink-2">None in this batch.</p>
        ) : (
          <Paged items={flagged} what="with a finding" className="space-y-3">
            {(each, focusable) => <RowCard key={each.row.line} result={each} byLine={byLine} focusable={focusable} />}
          </Paged>
        )}
      </ResultSection>

      {quiet.length > 0 && (
        <Disclosure
          summary={`${count(quiet.length, "row", "rows")} with nothing found`}
          onToggle={(event) => {
            if (event.currentTarget.open) setQuietOpened(true);
          }}
        >
          <p className="pb-2 text-xs leading-relaxed text-ink-3">None of these checks found anything on them. Nothing here says whose an address is.</p>
          {quietOpened && (
            <Paged items={quiet} what="with nothing found" className="space-y-1.5">
              {(each, focusable) => <QuietRow key={each.row.line} result={each} focusable={focusable} />}
            </Paged>
          )}
        </Disclosure>
      )}

      {result.leftOut > 0 && (
        <p className="text-sm leading-relaxed text-ink-2">{`The ${count(result.leftOut, "row", "rows")} after the first ${PAYOUT_ROWS_MAX.toLocaleString("en-US")} were not checked.`}</p>
      )}

      <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:flex-wrap sm:items-center">
        <Button type="button" icon={<Download />} onClick={onDownload}>
          Download the batch with the check
        </Button>
        <Button type="button" variant="secondary" icon={<ArrowLeft />} onClick={onBack}>
          Change columns
        </Button>
        <Button type="button" variant="ghost" icon={<RotateCcw />} onClick={onRestart}>
          Check another batch
        </Button>
      </div>
    </div>
  );
}
