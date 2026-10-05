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
  - Under them, a secondary (outlined) button reads "No wallet yet? Create one with a passkey". A link beneath it,
    "Already made one here? Use my passkey wallet", uses a wallet the payee made from an earlier link, so a second
    link never makes a second wallet.
  - It shows only for a payee paid on Arc testnet, and only when the Modular Wallets client key and client URL are
    configured.
- **P2: creating the wallet.**
  - The passkey code loads only when the button is chosen, or is about to be (the pointer or focus reaching it), so
    the address path stays as light as before: the module the link loads imports viem's types only.
  - The browser asks to create a passkey named after the business that pays, then a mark of eight hex characters, such
    as "Cong-ty-Dat-Viet-4f2a9c1e". The payee's own name is not sent to Circle. The wallet is a Circle Smart Account on
    Arc testnet, owned by that passkey.
  - Circle's rules for that name, as its registration answered on 2026-10-05:
    - 5 to 50 letters, digits and _@.:+- only (-32025), so accents are dropped and every other character becomes a
      hyphen;
    - a name is kept from the moment a registration asks for it, whether or not a passkey follows, and refused after
      (-32024), so every attempt draws a new mark.
  - While the passkey is asked, the address field and Continue wait, so a late answer never replaces a typed address.
  - Its address is worked out at once. Nothing is deployed, nothing is paid, and nothing about the passkey is stored by
    Vestiarion. The private key never leaves the payee's device or password manager.
- **P3: the address goes the way a typed one does.**
  - The new address is shown read back, under "Your new wallet" (or "Your passkey wallet" for one made before), and
    sent by "Send my address", the same action and record as a typed address.
  - A person at the business confirms it before any payment, as for every new address.
  - The three boxes a payee ticks for a typed address guard against a wrong copy or an exchange's deposit address. They
    do not apply to an address the page made. One line replaces them: the passkey opens this wallet later, at
    www.vestiarion.xyz/wallet.
- **P4: the wallet page, `/wallet`.** It is public, with no session.
  - "Open my wallet" asks for the passkey and shows the wallet's address and its USDC on Arc testnet.
  - "Send USDC" takes an address (the same checks as the forms: 0x and 40 characters, and a mixed-case address must
    match its checksum) and an amount, then a confirmation naming the destination, the amount, the network and the
    token.
  - Its USDC is read again before the review, and a Refresh reads it on request. A balance that could not be read is
    said so, never taken as none.
  - It sends as a user operation with gas sponsored by Circle Gas Station, signed under the passkey's own rpId (not
    the page's host), and waits for the receipt.
  - It says what came of the send: sent, with the transaction; reverted on Arc testnet, so nothing moved; or taken by
    Circle with no receipt read yet, so it may still land, and the payee checks the balance before sending again. Once
    Circle has taken a send, the page never says nothing was sent.
  - Vestiarion records none of it: the wallet is the payee's.
- **P5: failures say what happened.**
  - A passkey prompt cancelled or timed out: "No passkey was created. Nothing changed." (on the wallet page, "The passkey
    was not used. Nothing was sent.").
  - A browser without passkeys: "This browser cannot create passkeys. Enter an address from another wallet instead."
  - Anything else: "That did not work. Try again in a moment, or enter an address from another wallet." The error goes
    to the console only.
- **P6: configuration.** `NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_KEY` and `NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_URL`, from a
  Modular Wallets client key in the Circle Console whose passkey domain is www.vestiarion.xyz. Circle binds a client key
  to one domain, which must match the page's host exactly, so local development uses its own key for localhost. Both
  values are built into the pages: a change needs a redeploy.
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

- `tests/passkey-wallet.test.ts`, the modules with the SDK injected:
  - the passkey name;
  - the order for a new and a reused passkey;
  - each failure's sentence, a cancelled prompt however deep it is wrapped;
  - the USDC transfer's calldata, an address in one case alone, and amounts in 6 decimals;
  - the send's checks, a balance not read included;
  - the three outcomes of a send;
  - when the option is configured, and that the link's module imports viem's types only.
- `tests/passkey-wallet-sdk.test.ts`, the real binding with the browser's passkey API and the network faked:
  - the same wallet for Register and Login;
  - Circle asked on Arc testnet's path;
  - signing under the passkey's rpId;
  - the user operation's USDC transfer and paymaster;
  - reverted and unconfirmed sends.
- `tests/payee-passkey-option.test.tsx`:
  - the option, its reuse link and their secondary style;
  - Continue still the one submit;
  - only on Arc testnet and when configured;
  - the wallet page with and without configuration.
- `tests/docs-guides.test.ts`: the get-paid guide quotes the new copy.
