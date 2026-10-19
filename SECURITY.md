# Security policy

Vestiarion pays real money on Arc mainnet, so we want to hear about any vulnerability in it. How the app protects the
data and money it handles is on [www.vestiarion.xyz/security](https://www.vestiarion.xyz/security).

## Supported versions

| Version | Supported |
| --- | --- |
| The hosted service at [www.vestiarion.xyz](https://www.vestiarion.xyz), which runs `main` | Yes |
| The latest beta release, on [Releases](https://github.com/duongnq2798/vestiarion/releases) | Yes |
| Earlier beta releases | No: fixes land on `main` and in the next release |
| The latest [`@vestiarion/sdk`](https://www.npmjs.com/package/@vestiarion/sdk) and [`@vestiarion/cli`](https://www.npmjs.com/package/@vestiarion/cli) | Yes |

Vestiarion is in beta. A fix is made on `main`, which Vercel deploys, and named in the next release; there are no
back-ported fixes to older tags.

## Reporting a vulnerability

**Please do not put the details of a vulnerability in a public issue, a pull request or a discussion.**

Report it privately on GitHub: under the repository's **Security** tab, choose **Report a vulnerability**, or go
straight to [github.com/duongnq2798/vestiarion/security/advisories/new](https://github.com/duongnq2798/vestiarion/security/advisories/new).
The report is a private [security advisory](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/about-repository-security-advisories)
that only you and the maintainers can see. Say what is affected (the app, the API, a contract, the SDK or the CLI), how
to reproduce it, and what an attacker could do with it.

Please test only against workspaces you created yourself, on Arc testnet where you can. Do not read, change or delete
another workspace's data, do not move money that is not yours, and do not run tests that degrade the service for others.

## What to expect

- We aim to answer your report within 3 working days, and to tell you in the advisory within 10 working days whether
  we can reproduce it and what we will do.
- We fix confirmed vulnerabilities on `main`, credit you in the advisory and the release notes if you wish, and publish
  the advisory once the fix is deployed.
- When a vulnerability affected workspaces, we tell their owners what happened and what we changed.
- We have no bug bounty.

## Scope

In scope:

- the hosted app and its public pages, at [www.vestiarion.xyz](https://www.vestiarion.xyz);
- the REST API (`/api/v1`), the MCP server (`/api/mcp`) and the webhooks Vestiarion sends and receives;
- the contracts in [`contracts/`](contracts): `VestiarionSpendingLimit`, its version 2 `VestiarionSpendingLimitV2`
  and `VestiarionEscrow`, which have not been audited;
- the code in this repository, including [`sdk/`](sdk) and [`cli/`](cli), and the database migrations.

Out of scope:

- vulnerabilities in services Vestiarion uses, such as Circle, Arc, Supabase, Vercel or a connected tool, which go to
  that service;
- findings that need a compromised device or browser, social engineering, or physical access;
- denial of service by volume, and reports from automated scanners without a demonstrated impact;
- missing best-practice headers or settings with no demonstrated way to exploit them. What the app does not do yet is
  listed under "What we do not claim" on [the security page](https://www.vestiarion.xyz/security#not-claimed).
