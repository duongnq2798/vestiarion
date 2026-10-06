# What a mainnet user still sees wrong: phase 2e of the mainnet plan

Date: 2026-10-06. Status: designed on `feat/mainnet-polish`. Designed under the standing autonomy grant, after phases
2a–2d (#219–#222). It takes up minors that 2c's and 2d's final reviews deferred, where a person using a workspace on Arc
mainnet would see something false. Rulings carry their cost if wrong.

## 1. Why

- **2c's ratchet cannot see every false line.** Copy that names no network can still be wrong on Arc mainnet.
  - **A pay link pasted into a chat** shows the platform's preview card, whose footer says "Arc testnet". `/pay`,
    `/payee` and `/receipt` set no image of their own.
  - **The counterparty form's Chain field** says "Another chain is paid from Arc through CCTP, for a fee". Arc mainnet has
    no CCTP, and the field offers its own chain only.
  - **The cash outlook's short-day callout** says "with the USYC reserve brought back". It says so on a network with no
    reserve, and in a workspace whose reserve holds nothing.
  - **A contractor sent with another chain** is refused with "…a contractor's milestones are released on Arc testnet".
    That message also reaches a mainnet workspace through the API.
  - **The escrow, Gateway and service-budget actions** tell a mainnet sandbox to "take this workspace live first". Going
    live would not help: those features are not on Arc mainnet.
- **2d's watch does more than it needs.**
  - It visits every workspace every 5 minutes, including those that can hold no live payment.
  - It records the transaction hash from the row, even when Circle's answer now has one.
  - It would believe a simulator's "confirmed".
- **Two small mismatches:**
  - Getting-started says "0.1 USDC" for the gas reserve, where the guides and README say "0.10".
  - The status reference says a held state is not reported as `simulate`, when it used to read `live` as well.

## 2. Rulings

- **E1. A link page has its own preview card, and it names no network.**
  - `/pay/[token]`, `/payee/[token]` and `/receipt/[token]` each get an Open Graph and a Twitter image. Each is the
    platform's card with a badge for the page and the footer line "Arc", not "Arc testnet".
  - The image reads nothing: no link, no amount, no name. A preview is shown to whoever the link is pasted to.
  - The platform's own card keeps "Arc testnet" (2c C5).
  - *Cost if wrong:* a link's card does not name its network, but the page itself does.
- **E2. The Chain field says what the network offers.** Where the profile has CCTP, the text is as before. Otherwise:
  "{network} pays on its own chain only."
- **E3. The short-day callout mentions the reserve only when it holds something** (`outlook.reserve > 0`).
- **E4. The contractor-chain refusal names no network:** "Only a vendor can be paid on another chain; a contractor's
  milestones are released on the workspace's own chain."
- **E5. A feature the network lacks is refused by name first.** The escrow, Gateway and service-budget actions check the
  workspace's profile before its mode, and answer as the library already does (`FeatureOffError`).
- **E6. The watch visits only workspaces that can hold a live payment**: those with a hosted wallet, or Circle
  credentials stored.
  - A workspace with neither has only simulated payments, which are never watched (D9).
  - *Cost if wrong:* none. A live payment needs a wallet, and a wallet needs one of the two.
- **E7. The watch prefers Circle's answer.**
  - It records the transaction hash Circle answers with, when the row has none.
  - It treats a provider that is not live as not asked, rather than believing its "confirmed".
- **E8. The two mismatches.**
  - Getting-started prints the gas reserve with two decimals ("0.10 USDC").
  - The status reference says the held states are not reported as `live` or `simulate`.

## 3. Testing

- E1: the three image routes render, and their element tree has the "Arc" footer, not "Arc testnet".
- E2: the intake form's chain help, on each network.
- E3: the callout, with a reserve and with none.
- E4: the validation message.
- E5: each action, on a mainnet sandbox.
- E6, E7: the watch's org filter, the answer's hash, and a non-live provider.
- E8: getting-started on Arc mainnet.
- The copy ratchet's allowance for `intake-validation.ts` drops.

## 4. Rollout

No migration. Production does not change, beyond the three link pages' preview cards and the wording above.
