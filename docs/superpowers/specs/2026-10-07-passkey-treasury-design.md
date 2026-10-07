# A passkey wallet as the treasury, and a Go live that meets each owner where they are

Decided on 2026-10-07 by the implementer, under the partner's standing instruction and their request the same day
("Sao không cho user sử dụng passkey luôn… design flow thật tinh tế, thuận tiện cho cả user có ví metamask, rabby hay cả
khi user không hề có 1 wallet nào trước đó"). It builds on the wallet treasury
(`docs/superpowers/specs/2026-10-07-wallet-treasury-design.md`, W1–W17), whose rules hold unless a decision here says
otherwise. Each decision states its reason.

## 1. Why

- **An owner with no browser wallet hits a wall.** Path C asks for MetaMask, Rabby or another injected wallet. Without
  one, the page says "No wallet was found in this browser" twice and offers nothing else (seen 2026-10-07).
- **Circle's passkey wallets now run on Arc mainnet.** Modular Wallets' docs list Arc testnet only, but the partner's
  mainnet client key answered on 2026-10-07: chain `arc` gives `eth_chainId` `0x13b2` (5042) and
  `eth_supportedEntryPoints` EntryPoint v0.7. On chain, Arc mainnet already has:
  - EntryPoint v0.7 and v0.8;
  - Circle's smart account factory `0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD`, its implementation and its WebAuthn
    multisig plugin, the same bytes as on Arc testnet;
  - the deterministic deployment proxy `0x4e59b44847b379578588920cA78FbF26c0b4956C`, and CreateX.
- **A passkey wallet stays the owner's.** It is a smart account owned by a passkey on the owner's device, which Circle's
  passkey service only stores the public part of. Vestiarion holds no key to it, as W1 requires of the treasury.
- **It can be simpler than an injected wallet.** A smart account sends several calls in one user operation, so the
  setup can be one confirmation where path C's wallet route takes four.

## 2. What it builds

Go live's step 1, "Choose where the treasury lives", reads what the browser has:

- **A wallet in the browser** (MetaMask, Rabby, Coinbase Wallet…): "Connect MetaMask" leads, with the passkey below it.
- **No wallet:** **Create a wallet with a passkey** leads. No error is shown for a missing wallet; a line says the owner
  can install one and reload instead.
- **Either way:** "Connect your own Circle account" stays folded below, as now.

The passkey route:

1. **Create the wallet.** One prompt (Face ID, Touch ID, Windows Hello or a phone). The page shows the new wallet's
   address. Vestiarion creates the agent's wallet at once.
2. **Add USDC.** The owner sends USDC on Arc mainnet to the address, from an exchange or another wallet. The page shows
   what is there and what setup needs, and reads it again by itself.
3. **Set up with one confirmation.** The owner sets the daily and 7-day figures, sees in words what the confirmation
   does, and confirms once with the passkey. In one user operation the wallet deploys its contract, approves it, and
   sends the agent 0.50 USDC for gas.
4. **Save a recovery phrase.** Twelve words made in the browser, registered with one more confirmation, so a lost
   passkey does not lose the wallet. The owner may skip it, explicitly.
5. **Go live**, typing `mainnet` as today.

## 3. Decisions

- **K1. Step 1 leads with what the browser has.**
  - The page looks for wallets as now (EIP-6963, then `window.ethereum`), for 300 ms.
  - Wallets found: the connect card leads, naming the wallet ("Connect MetaMask"; with several, the picker as now).
  - None found: the passkey card leads.
  - The passkey card shows only where it can work: the browser has WebAuthn (`window.PublicKeyCredential`) and the
    deployment has the mainnet client key (K11).
  - Both cards are shown whenever both can work. A missing wallet is never an error before the owner asks for one.
- **K2. A passkey wallet is a Circle Smart Account on Arc mainnet.**
  - Circle's MSCA (ERC-6900, EntryPoint v0.7), owned by a WebAuthn passkey, through Circle's passkey service and bundler
    for chain `arc` (`toPasskeyTransport`, `toModularTransport(<client url>/arc)`, `toCircleSmartAccount`).
  - It is the same machinery as the payee passkey wallet (`src/lib/passkey-wallet*.ts`), pointed at Arc mainnet.
  - The passkey is saved under a name from the workspace, as `passkeyName` writes it.
- **K3. Choosing a passkey wallet proves nothing yet, and need not.**
  - It records the wallet's address as the treasury, as W3 does, with `treasury_signer = 'passkey'`, but asks for no
    signed message: a smart account's signature needs ERC-6492 to check before it exists, and one more prompt.
  - Control is proven on chain instead: the setup (K6) approves the contract **from the wallet itself**, which only the
    passkey can do. An address the owner does not control never gets past setup.
  - The ledger records `treasury_wallet_chosen` `{ by, address, signer: "passkey", network }`.
  - The wallet route keeps W3's signed proof and `treasury_wallet_proven` unchanged.
  - As W3, the choice may be made again until a contract is deployed.
- **K4. The agent's wallet is created with the choice, on both routes.** It needs nothing from the owner, so the separate
  "Create the agent's wallet" click goes: choosing creates it in the same action. If Circle fails, the step stays as
  now, with its button, and the choice is kept.
- **K5. Setup waits for the wallet's USDC.**
  - Below what setup needs, the passkey route shows the address (with a copy button), the wallet's USDC, and what
    setup needs: 0.50 USDC for the agent's gas plus the network fee, estimated as 0.05 USDC and shown as "about".
  - The page reads the balance again every 10 seconds while open, and when the tab is shown again.
  - The owner's own payments come on top: the page says so.
- **K6. One confirmation sets everything up.**
  - The server builds three calls (W7: it builds every transaction):
    1. Deploy the contract through the deterministic deployment proxy: `to` the proxy, `data` a salt then the contract's
       creation code with this wallet, this agent and the figures. The salt is `keccak256("vestiarion:spending-limit:" +
       orgId)`, so the address is known before anything is sent. Where Vestiarion's contract for these is already at
       that address (a setup sent before whose recording was lost), the deploy call is left out and the other two go.
    2. `approve(contract, amount)` on USDC: unlimited, or the owner's cap, as W9.
    3. 0.50 USDC (Arc's native currency) to the agent's wallet.
  - **The browser checks every call before the passkey signs**, because a passkey prompt shows no transaction. It
    rebuilds each call from what it knows (the bundled contract code, the wallet, the agent and the figures shown, USDC's
    address, the contract address computed from the proxy, salt and code) and refuses anything that differs.
  - It then shows the three in words and sends them as one user operation, whose gas the wallet pays from its own USDC.
    No paymaster: none is offered on Arc mainnet.
- **K7. The setup is recorded from the chain, once.**
  - The browser hands back the transaction hash from the user operation's receipt.
  - The server checks:
    - the transaction succeeded;
    - the code at the computed address equals Vestiarion's contract for this wallet and agent (as W8);
    - the figures read from it;
    - `allowance(wallet, contract)` is at least one unit (as W9);
    - the agent holds its gas minimum.
  - It records what the wallet route records: `agent_budget_changed` when the figures differ,
    `spending_limit_deployed`, and `spending_limit_enforced` with `walletHost: "external"` and `signer: "passkey"`.
  - Asking again about a recorded setup answers it without recording it twice, as on the wallet route.
- **K8. A recovery phrase before going live.**
  - After setup, the passkey route asks the owner to save a recovery phrase:
    - twelve words (`generateMnemonic`, English), made in the browser, shown once, never sent anywhere;
    - their address registered as a recovery owner with Circle's `registerRecoveryAddress`, one passkey confirmation.
  - The owner confirms they saved the words before the confirmation is asked.
  - Recorded as `treasury_recovery_registered` `{ by, recoveryAddress, txHash }`.
  - **Skipping it is explicit:** "Skip: I understand that losing this passkey loses this wallet", recorded as
    `treasury_recovery_skipped` `{ by }`.
  - Going live on the passkey route needs one or the other.
- **K9. The browser keeps the passkey's public part.**
  - After it is created or used, the credential's id, public key and relying party are kept in `localStorage` for the
    workspace. They are public by nature; the private key never leaves the authenticator.
  - Later steps sign with it without asking the owner to log in first.
  - Without it (another browser, cleared storage), the page asks the passkey to log in (Circle's `Login` mode) and checks
    that the wallet it owns is the workspace's treasury, refusing another by name.
- **K10. Failures are said plainly, and nothing is sent twice.**
  - A cancelled prompt: "The passkey was not used. Nothing changed."
  - Not enough USDC: what is missing, in USDC.
  - Circle's bundler unreachable: nothing sent, try again.
  - A user operation that reverted: nothing moved.
  - One sent whose receipt could not be read: kept as the wallet route keeps its hash, and checked again, never resent
    blind.
- **K11. Configuration.**
  - `NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_KEY`: the Circle mainnet client key, bound to `www.vestiarion.xyz`. A
    client key is for browsers by design; its allowed domain is what guards it.
  - `NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_URL`: optional, by default `https://modular-sdk.circle.com/v1/rpc/w3s/buidl`.
  - Arc mainnet's network profile gains `modularWallets: { chain: "arc" }`. The payee passkey wallet stays on Arc
    testnet: its constant is unchanged.
- **K12. Migration 0083** adds three columns to `spending_limit_contracts`, and the row now exists from the choice on:
  - `treasury_signer`: `'wallet'` or `'passkey'`, default `'wallet'`;
  - `recovery_address`: format checked;
  - `recovery_skipped_at`.
  - Both routes write `treasury_signer` when the owner chooses; the row is inserted if absent.

## 4. Security

- **No key to the treasury is held by Vestiarion.** The passkey's private key stays in the owner's authenticator. The
  recovery words never leave the browser. Circle's passkey service holds only public keys, as for payee wallets.
- **The browser refuses calls it did not expect (K6),** so a server bug or a tampered response cannot have the passkey
  sign a transfer of the treasury.
- **The contract's bounds are unchanged.** The agent pays only through `pay()`, within the figures that only the treasury
  (now the smart account) can change.
- **Control is proven on chain (K3).** The approval, which only the wallet's owner can make, is what puts any money
  within the agent's reach.
- **The client key is public by design** and bound to `www.vestiarion.xyz`; it can create passkeys and send user
  operations for wallets whose passkeys sign them, nothing else.

## 5. Components

- **`src/lib/passkey-treasury.ts` (new, browser-safe):**
  - the config from K11;
  - the setup calls rebuilt and checked (K6);
  - the CREATE2 address;
  - the credential kept per workspace (K9);
  - the failures (K10).
- **`src/lib/passkey-treasury-sdk.ts` (new, browser only):** the SDK and viem bound to Arc mainnet, loaded on demand like
  `passkey-wallet-sdk.ts`.
- **`src/lib/treasury/wallet-treasury.ts`:**
  - `choosePasskeyTreasury`;
  - the agent created with the choice;
  - `preparePasskeySetup`;
  - `recordPasskeySetup`;
  - `recordRecovery` and `skipRecovery`;
  - the status's `signer`, `recovery` and funding figures.
- **`src/lib/treasury/verify.ts`:** a deployment checked at an address, with no receipt `from` (the bundler sends it).
- **`src/app/actions/wallet-treasury.ts`:** the new actions, owner only, gated as the access check requires.
- **`src/components/treasury/WalletTreasuryChoice.tsx` and `PasskeyTreasurySteps.tsx`:** the choice (K1) and the
  passkey route's steps. They are split from `WalletTreasurySteps.tsx`, which keeps the wallet route.
- **`supabase/migrations/0083_passkey_treasury.sql`.**
- **Docs:**
  - the Go live guide's path C, with the passkey route, its screenshots and its messages;
  - the changelog's new ledger entries;
  - README and ARCHITECTURE.

## 6. Order of work

1. Profile, config and migration.
2. The server's choice, agent and status.
3. The setup calls and their check, then the recording from the chain.
4. Recovery.
5. Actions.
6. The browser's passkey route.
7. The choice that leads with what the browser has.
8. Docs and screenshots.

## 7. Not in scope

- **A paymaster for the setup.** The wallet pays its own gas. Circle's paymaster does not list Arc mainnet.
- **Money in, changing figures or revoking from the passkey, and topping up the agent's gas after going live:** the
  wallet treasury's part 2. The passkey route will use the same user operations.
- **Batching the injected wallet route** (EIP-5792 `wallet_sendCalls`): a later improvement for wallets that support it.
- **Recovery from a lost passkey inside Vestiarion.** The phrase works with Circle's `executeRecovery`. A recovery page
  comes with part 2; until then the guide says the phrase is the way back.
