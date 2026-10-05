# A payee with no wallet creates one with a passkey

Date: 2026-10-05. Status: implemented on `feat/payee-passkey-wallet`. Roadmap T7. On Arc testnet, with Circle Modular
Wallets and Gas Station. The partner's direction: the address a payee enters stays the main path, and creating a
passkey wallet is the secondary one.

## 1. The problem

A payee link asks for a wallet address. A freelancer with no crypto wallet stops there. Installing a wallet app,
writing down a recovery phrase and finding the Arc testnet network is more than a first payment should ask.

Circle Modular Wallets give a smart account owned by a passkey: the fingerprint, face or PIN a phone or laptop already
uses. Its address is known as soon as the passkey exists. Nothing is deployed until it first sends, and Circle Gas
Station pays that gas.

## 2. Rulings

- **P1: the address stays the main path.** The payee link's address field and its Continue button stay the page's
  primary action, unchanged.
  - Under them, a secondary text button reads "No wallet yet? Create one with a passkey".
  - It shows only for a payee paid on Arc testnet, and only when the Modular Wallets client key and client URL are
    configured.
- **P2: creating the wallet.**
  - The passkey code loads only when the button is chosen, so the address path stays as light as before.
  - The browser asks to create a passkey named after the payee and Vestiarion. The wallet is a Circle Smart Account on
    Arc testnet, owned by that passkey.
  - Its address is worked out at once. Nothing is deployed, nothing is paid, and nothing about the passkey is stored by
    Vestiarion. The private key never leaves the payee's device or password manager.
- **P3: the address goes the way a typed one does.**
  - The new address is shown read back, under "Your new wallet", and sent by "Send my address", the same action and
    record as a typed address.
  - A person at the business confirms it before any payment, as for every new address.
  - The three boxes a payee ticks for a typed address guard against a wrong copy or an exchange's deposit address. They
    do not apply to an address the page made. One line replaces them: the passkey opens this wallet later, at
    www.vestiarion.xyz/wallet.
- **P4: the wallet page, `/wallet`.** It is public, with no session.
  - "Open my wallet" asks for the passkey and shows the wallet's address and its USDC on Arc testnet.
  - "Send USDC" takes an address (the same checks as the forms: 0x and 40 characters, and a mixed-case address must
    match its checksum) and an amount, then a confirmation naming the destination, the amount, the network and the
    token.
  - It sends as a user operation with gas sponsored by Circle Gas Station, waits for the receipt, and links the
    transaction on the Arc explorer.
  - Vestiarion records none of it: the wallet is the payee's.
- **P5: failures say what happened.**
  - A passkey prompt cancelled or timed out: "No passkey was created. Nothing changed." (on the wallet page, "The passkey
    was not used. Nothing was sent.").
  - A browser without passkeys: "This browser cannot create passkeys. Enter an address from another wallet instead."
  - Anything else: "That did not work. Try again in a moment, or enter an address from another wallet." The error goes
    to the console only.
- **P6: configuration.** `NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_KEY` and `NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_URL`, from a
  Modular Wallets client key in the Circle Console whose passkey domain is www.vestiarion.xyz (and localhost for
  development).
  - Missing either: no button, and `/wallet` says passkey wallets are not available here yet.
  - The client key is meant for the browser: it identifies the app to Circle and carries no right to move money.
- **P7: privacy.** The privacy page names Circle for a payee who creates a passkey wallet. Circle receives the passkey's
  public key, its credential id and the name it is saved under, and the wallet's user operations. The private key is
  never sent anywhere.

## 3. What does not change

- The payee link's typed-address path, its server action, and the confirmation by a person at the business.
- How Vestiarion pays: a passkey wallet's address is paid like any other address on Arc testnet.

## 4. Known limits

- A passkey is bound to www.vestiarion.xyz. A passkey made on another domain (a preview deployment) does not open the
  wallet here.
- Recovery: a lost passkey loses the wallet. Passkeys synced by the payee's platform (iCloud Keychain, Google Password
  Manager) survive a lost device. A recovery phrase (the SDK's BIP-39 module) is left for later.
- Only Arc testnet: a payee paid on another chain sees no passkey option.
- The live test needs the partner's Modular Wallets client key; until then the option stays hidden in production.

## 5. Tests

- `tests/passkey-wallet.test.ts`, the module with the SDK injected:
  - the passkey name;
  - the order: register, transport, smart account, address;
  - each failure's sentence;
  - the USDC transfer's calldata and amount in 6 decimals;
  - the send's address and amount checks;
  - when the option is configured.
- `tests/payee-journey.test.tsx`:
  - the passkey option only on Arc testnet and when configured;
  - Continue still the one primary button;
  - the read-back with its one line.
- `tests/wallet-page.test.tsx`: not configured, and the first screen.
- `tests/legal-pages.test.tsx`, `tests/docs-guides.test.ts`: the privacy page and the get-paid guide.
