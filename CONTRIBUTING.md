# Contributing to Vestiarion

Vestiarion is built in public by a small team, and it pays real money on Arc mainnet. Issues and focused pull requests
are welcome. This page says how a change is proposed and decided, how to run the app and its tests, and what a pull
request needs in this repository.

- **A security vulnerability** never goes in an issue or a pull request: report it privately, as
  [SECURITY.md](SECURITY.md) says.
- **A barrier for people with disabilities** has its own form: see [ACCESSIBILITY.md](ACCESSIBILITY.md).
- **Questions about using the product** are answered in the [docs](https://www.vestiarion.xyz/docs). The repository has
  no Discussions; the project is on X as [@vestiarionhq](https://x.com/vestiarionhq).
- Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## How a change is decided

As of October 2026, every pull request merged into this repository was opened by the team itself. What follows is how
we will handle yours.

- **A bug:** open an issue with the bug report form. A pull request that fixes it can come with the issue or after it.
- **A small change** (a fix, a missing test, a docs correction): open a pull request from your fork.
- **Anything larger** (a feature, an integration, a change to how a payment is decided, approved or sent, the database
  schema, `/api/v1` or the webhooks): open an issue with the feature request form first, and wait until a maintainer
  agrees on the approach before you build it. A large pull request with no agreed issue may be closed with a pointer to
  open one.
- The maintainers decide what is merged. We may decline a change, or ask for it to be reworked, even when it is
  correct: for example when it widens what the agent can do without a person, or adds something we would have to run
  and support. Asking in an issue first saves your time.
- `main` is a protected branch: every change reaches it through a pull request whose CI run passed, the maintainers'
  own included. The branch rule requires CI to pass, not an approving review. A maintainer reviews a contributor's pull
  request before merging it.

## Running it locally

You need Node.js and npm. CI runs Node 24, so use Node 24 to see what CI sees. The repository is developed on Windows
and tested on Linux; `.gitattributes` keeps text files at LF line endings on both.

To change the code and run the tests, nothing else is needed:

```bash
npm install
npm run verify
```

The test suite needs no Supabase project, Circle account or model key. `tests/setup.ts` makes any `fetch` to a host
other than this machine fail at once, so a test that reaches the network through `fetch` fails instead of waiting. The
suite runs every migration on an in-process Postgres (PGlite), on UTC whatever your time zone.

To run the app itself, you need a [Supabase](https://supabase.com) project of your own, made for development, never
one that holds real workspaces:

```bash
cp .env.example .env.local   # Supabase URL and keys, VESTIARION_MASTER_KEYS, SUPABASE_JWT_SECRET
npm run db:migrate
npm run dev
```

`npm run db:migrate` connects with `SUPABASE_DB_URL` when it is set: the simplest is to copy the session pooler's
connection string from the project's connection settings. Without it, it builds the session pooler's address from
`SUPABASE_PROJECT_ID` and `SUPABASE_DATABASE_PASSWORD`, in the region `SUPABASE_REGION` names, `us-east-1` when it is
not set.

Sign in at `http://localhost:3000/login`; a first sign-in asks for a business name and creates a sandbox workspace.
With no Circle or model keys, payments are simulated and decisions come from the rule-based policy, so the app runs
end to end with no other credentials. [docs/self-hosting.md](docs/self-hosting.md) covers every variable, the scripts
and going live. `npm run seed -- <org-slug>` replaces that workspace's business data with a fictional fixture (the
slug is the part after `/o/` in the workspace's address); it is destructive, so use it only on a disposable demo
database.

The app runs Next.js 16, which has breaking changes from earlier versions: read the relevant guide in
`node_modules/next/dist/docs/` before writing code against it. `next dev` writes the first block of `AGENTS.md`
itself; leave it as it is.

## What a pull request needs

### One change, described

Keep a pull request to one change, and fill in its template: Summary, Why, What changed, Safety, Migration, Tests and
Docs. Write commit messages that say plainly what changed, as a sentence: "Post bills waiting for details to Discord,
as Slack does".

### Tests first, and `npm run verify` passing

Write the test that shows the bug or the new behaviour first, see it fail, then change the code.

`npm run verify` runs the lockfile check, the typecheck, lint and the whole Vitest suite. CI runs the same steps, then
`npm run build`, on every pull request and every push to `main`, on Node 24 and with no secrets. A pull request is
merged only once CI passes.

Say in a test what it holds. A feature's tests cite its design and the ids of the rules they check:
`tests/slack-blocks.test.ts`, for one, cites `SR2` to `SR4` of
`docs/superpowers/specs/2026-10-27-slack-review-links-design.md`.

### A design for a feature

A feature starts with a design in `docs/superpowers/specs/`, named `YYYY-MM-DD-<topic>-design.md`: why it is needed,
its rules, each with a short id (`SR1`, `SR2`, ...), and the tests that hold each rule.
[`2026-10-27-slack-review-links-design.md`](docs/superpowers/specs/2026-10-27-slack-review-links-design.md) shows the
shape. A bug fix needs none.

### Every affected doc, in the same pull request

- **`CHANGELOG.md`:** an entry under `[Unreleased]`, in Added, Changed or Fixed, with a bold title, written for the
  people who run a business on Vestiarion. It ends with "No migration." or names the migration.
- **`content/docs/changelog.mdx`:** when `/api/v1` or the webhooks change, an entry headed `## YYYY-MM-DD: <title>`,
  newest first, saying what changed for an integrator.
- **The guides** in `content/docs/guides/` quote the app's buttons, fields and messages exactly.
  `tests/docs-guides.test.ts` holds a list of quoted strings, each with the file it comes from, and fails when the
  guide or the file no longer contains one. When a guide quotes new app text, add it to that list. Quotes not on the
  list are not checked, so search the guides for a button or message you rename.
- **`README.md`, `ARCHITECTURE.md` and `docs/self-hosting.md`,** wherever they describe what you changed. Search for the
  old wording.
- **Screenshots:** after changing a screen a guide shows, `npm run docs:screenshots` rebuilds the guides' screenshots
  with headless Microsoft Edge (set `EDGE_PATH` if Edge is not at its Windows default path). Look at each PNG before
  committing it.

### Generated files, regenerated and committed

| When you change | Run | Commit |
| --- | --- | --- |
| An `/api/v1` operation (`src/lib/api/openapi.ts`) | `npm run sdk:types` and `npm run postman:build` | `sdk/src/types.ts` and `public/postman/` |
| The decision code, or the Quality Lab's scenarios | `npm run quality-lab` | `src/lib/data/quality-lab.json` and `src/lib/data/quality-lab-shadow.json` |

The tests fail while a committed file differs from what its command produces. `npm run quality-lab` needs no database,
key or network. Its input `src/lib/quality-lab/shadow-decisions.json` is exported from production by a maintainer:
never edit it by hand.

The SDK (`sdk/`) and the CLI (`cli/`) have their own versions. A change to either, a regenerated `sdk/src/types.ts`
included, needs a new version and its tarball (`npm run sdk:pack` or `npm run cli:pack`, committed under
`public/sdk/` or `public/cli/`), since a version already packed is never packed again, and an owner of the npm
organization publishes it ([docs/RELEASING.md](docs/RELEASING.md#the-sdk)). Ask in the issue before raising a version.

### Database changes

- A schema change is a new file in `supabase/migrations/`: a four-digit number after the highest one on `main`, then
  lower-case words joined by underscores, such as `0146_what_it_does.sql`. Tests refuse a name without that shape,
  and two files with one number. Put a change in a new file rather than editing one already on `main`.
- Every `npm run db:migrate` applies every file again, in filename order, each in its own transaction, so a migration
  must be safe to run twice.
- Tenant data is read and written through `db()` or `platformDb()` from `@/lib/dal`. Lint refuses the raw Supabase
  client anywhere in `src/` outside the data access layer (`src/lib/dal/`).
- A pull request never applies a migration to production, and neither does a release: a maintainer applies it with the
  merge that needs it ([docs/RELEASING.md](docs/RELEASING.md#deployments-and-migrations)).

### Screens

- Build screens from the components in `src/components/ui`. `tests/ui-consistency.test.ts` fails, naming the file and
  line, on a raw `<button>`, `<select>`, `<textarea>` or visible `<input>` outside that folder, a hard-coded colour, a
  radius off the scale, keyboard focus shown only as a soft halo, or an agent-blue region without `focus-inverse`.
- [`docs/design/visual-system.md`](docs/design/visual-system.md) has the palette, the type roles and the focus rules.
  Check a changed screen at 520px wide with reduced motion on, and with Tab and Shift+Tab.
- In the docs' MDX, a quote or an apostrophe earlier on a line than an issue number such as #990 trips the colour check:
  rephrase the line or break it.

### No secrets, no private details

- Never commit an API key, a Circle entity secret, a wallet's private key or recovery phrase, a `.env.local` file (git
  ignores `.env*` files except `.env.example`), or anyone's personal data. Use invented values in tests and fixtures.
- The repository is public: keep local file paths, machine and user names, and the names of private workspaces out of
  code, docs, commit messages and pull request text.
- A dependency change commits the updated `package-lock.json`. `npm run check:lock` fails when the lockfile no longer
  describes `package.json`.

## License

Vestiarion is under the [MIT License](LICENSE), copyright "Vestiarion contributors". By opening a pull request you agree
that your contribution is licensed under the same terms. There is no contributor license agreement to sign.
