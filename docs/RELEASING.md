# Releasing Vestiarion

A release is a named, approved snapshot of `main`: an annotated git tag, a GitHub Release with notes, and an entry
in [CHANGELOG.md](../CHANGELOG.md). It is not a deployment. Vercel deploys `main` on every merge, so production usually
runs the latest release plus whatever was merged after it.

| Piece | Where | Who |
| --- | --- | --- |
| Version tag `vX.Y.Z[-beta.N]` | git, pushed to GitHub | A maintainer, by hand |
| GitHub Release | [Releases](https://github.com/duongnq2798/vestiarion/releases) | [`.github/workflows/release.yml`](../.github/workflows/release.yml), started by hand |
| Curated notes | `docs/releases/<tag>.md` | Written in a pull request before tagging |
| Generated notes | Appended by GitHub, grouped by [`.github/release.yml`](../.github/release.yml) | GitHub |
| Business changelog | [CHANGELOG.md](../CHANGELOG.md) | Written in the same pull request |
| API and webhooks changelog | [`content/docs/changelog.mdx`](../content/docs/changelog.mdx) | Every pull request that changes `/api/v1` or webhooks, as before |

## Versions

The product's version is its git tag, [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) with a `v`:

- `vX.Y.Z` is a stable release; `vX.Y.Z-alpha.N`, `vX.Y.Z-beta.N` and `vX.Y.Z-rc.N` are prereleases, N from 1.
- Nothing else is a release tag: no build metadata (`+…`), no other words, no leading zeros.
  [`scripts/release-check.mjs`](../scripts/release-check.mjs) holds the rule and
  [`tests/release-check.test.ts`](../tests/release-check.test.ts) lists what it accepts and refuses.
- While the major version is 0, anything may change between minor versions. Raise the minor version (0.2.0) for new
  features, the patch version (0.1.1) for fixes only, and go to 1.0.0 when `/api/v1`, the ledger format and the
  payment guarantees are promised stable.
- The root `package.json` `version` is not the product's version: the package is private and nothing reads it. Leave it
  alone; the tag is the source of truth.
- Migrations are numbered files (`supabase/migrations/0106_…`), not versions. A release says which migrations it
  contains.
- The TypeScript SDK and the CLI each have their own line; see [The SDK](#the-sdk) and [The CLI](#the-cli).

**Where it starts.** The first release is `v0.1.0-beta.1`: the product is live, with real users on Arc testnet and an
Arc mainnet path that has settled real USDC, so it is past an alpha; it changes every day and its contracts are not
audited, so it is not stable, and an `rc` would promise a freeze nobody intends yet. Later releases on this line are
`v0.1.0-beta.2`, `-beta.3`, … for each batch worth naming (a week's work, or a feature a customer waits for); then
`v0.1.0-rc.1` when the work stops adding features, and `v0.1.0` when it is called stable.

## Release, step by step

Commands work in PowerShell and in bash. Replace `v0.1.0-beta.2` with the version being released.

### 1. Prepare the notes, in a pull request

1. Write `docs/releases/v0.1.0-beta.2.md`. Its first line is the release title and must name the tag:
   `# Vestiarion v0.1.0-beta.2 — <short name>`. Under it, for business readers: highlights, what changed, the
   migrations it contains, known limitations. Cite pull requests as `#123`; GitHub links them.
2. In `CHANGELOG.md`, move what `[Unreleased]` holds into `## [0.1.0-beta.2] - <date>` and update the links at the
   bottom:
   `[Unreleased]: …/compare/v0.1.0-beta.2...HEAD` and `[0.1.0-beta.2]: …/releases/tag/v0.1.0-beta.2`.
3. Check the tag name: `node scripts/release-check.mjs tag v0.1.0-beta.2`.
4. Open the pull request, let CI pass, merge it.

The release workflow reads the notes from `main` when it runs, so they can land after the commit being released.

### 2. Pick the commit and check CI

Release a commit of `main` on which CI's `verify` passed. Usually that is the tip of `main`:

```bash
git fetch origin --tags
git rev-parse origin/main
gh api 'repos/duongnq2798/vestiarion/commits/<sha>/check-runs?check_name=verify' --jq '.check_runs[] | [.status, .conclusion, .html_url] | @tsv'
```

It must print `completed  success`. CI cancels the run of a commit when another lands on `main` right after it; pick a
commit whose run finished, or re-run the cancelled one from the Actions tab.

### 3. Create and push the tag

An annotated tag, signed if you have a signing key set up (see [Signing](#signing)):

```bash
git tag -s v0.1.0-beta.2 <sha> -m "Vestiarion v0.1.0-beta.2"   # signed
git tag -a v0.1.0-beta.2 <sha> -m "Vestiarion v0.1.0-beta.2"   # unsigned
git show --no-patch v0.1.0-beta.2
git push origin refs/tags/v0.1.0-beta.2
```

Push that one tag by its full name; never `git push --tags`. Pushing a tag starts no workflow and no deployment.

### 4. Publish the release

Check first, then create:

```bash
gh workflow run release.yml -f tag=v0.1.0-beta.2 -f dry_run=true
gh run list --workflow release.yml --limit 1
gh run watch <run-id>
gh workflow run release.yml -f tag=v0.1.0-beta.2
```

The **Check the tag** job reads and verifies, with `contents: read` and `checks: read`:

1. the run is from `main`;
2. the tag is a release tag (`scripts/release-check.mjs`);
3. it is on GitHub, annotated, and points at a commit; its signature status is noted, not required;
4. that commit is on `main`;
5. CI's latest `verify` on that commit succeeded;
6. no release exists for the tag yet. If one does, the run stops here, green, and changes nothing;
7. `docs/releases/<tag>.md`, if present, is titled with the tag.

The run's summary shows the commit, the CI run, the signature and what will be created. Then **Create the release**,
the only job with `contents: write`, which runs no code from the repository, checks the tag has not moved and runs
`gh release create <tag> --verify-tag --generate-notes`, with the curated notes first and GitHub's generated list of
pull requests after them. A prerelease (`alpha`, `beta`, `rc`) is marked prerelease and never Latest; a stable release
is marked Latest by GitHub when it is the newest by date and version.

Without Actions, the same release by hand, from the repository root, after checking steps 2 and 3 yourself (the
first command prints the title and writes the notes without it; drop `--prerelease --latest=false` for a stable
release):

```bash
node scripts/release-check.mjs notes v0.1.0-beta.2 docs/releases/v0.1.0-beta.2.md release-body.md
gh release create v0.1.0-beta.2 --verify-tag --prerelease --latest=false --generate-notes --title "<the printed title>" --notes-file release-body.md
```

## Labels and generated notes

GitHub groups the generated list by label, first match wins, as `.github/release.yml` says: Breaking changes
(`breaking-change`), Security and payment safety (`security`), Database and migrations (`database`), New features
(`enhancement`), Fixes (`bug`), Accessibility (`accessibility`), Documentation (`documentation`), and Other changes for
everything else, so nothing merged is dropped. A pull request labelled `ignore-for-release` is left out.

`enhancement`, `bug`, `accessibility` and `documentation` exist. `breaking-change`, `security`, `database` and
`ignore-for-release` are to be created when wanted (`gh label create security --color B60205`). Until pull requests carry
labels, the generated list is one "Other changes" section; the curated notes are what readers read.

## Signing

GitHub shows a tag as **Verified** when the tag object is signed with a GPG, SSH or S/MIME key that is uploaded to the
tagger's GitHub account as a signing key, and the tagger email is a verified email of that account. Only annotated tags
(`git tag -s`) carry a signature; a lightweight tag cannot be signed, and the release workflow refuses one.

Today no signing key is configured in this repository's or the maintainer's git (`gpg.format`, `user.signingkey`,
`tag.gpgSign` are unset). Merge commits on `main` show Verified because GitHub signs the merges it makes; commits made
locally show unsigned. Until a key is set up, tag with `git tag -a`: the release is valid, but it must not be described
as signed or verified.

To sign with SSH (git 2.34 or later):

```bash
git config --global gpg.format ssh
git config --global user.signingkey <path-to-your-public-key.pub>
git config --global tag.gpgSign true
```

Then add that public key on GitHub under **Settings → SSH and GPG keys → New SSH key**, key type **Signing Key**, and
make sure `git config user.email` is a verified email on the account. `git tag -s` then signs, and
`git tag -v <tag>` checks it locally (with `gpg.ssh.allowedSignersFile` set). With GPG instead, set `gpg.format openpgp`,
`user.signingkey <key id>`, and upload the public key as a GPG key. Never commit a key or put one in a workflow.

## When something fails

| The run says | What to do |
| --- | --- |
| Not a release tag | Use `vX.Y.Z` or `vX.Y.Z-alpha.N`, `-beta.N`, `-rc.N`. |
| `<tag>` is not on GitHub | Push it: `git push origin refs/tags/<tag>`. |
| A lightweight tag | It was made without `-a` or `-s`. If no release uses it yet, delete it on GitHub and locally, then tag again with `-a`. |
| Not on `main` | Tag a commit of `main`, not of a branch. |
| `verify` never ran, failed or was cancelled | Pick another commit, or re-run CI on that one from the Actions tab. |
| The release already exists | Nothing was changed. To change its notes, see below. |
| `docs/releases/<tag>.md` cannot be used | Its first line must be `# …<tag>…` with text under it; fix it in a pull request. |
| The tag moved since it was checked | Someone re-pushed the tag; find out why before running again. |
| Run the release workflow from `main` | Start it without `--ref`, or choose `main` in the Actions tab. |

## Fixing a wrong release

- **Notes or title wrong:** fix `docs/releases/<tag>.md` in a pull request, then
  `gh release edit <tag> --notes-file docs/releases/<tag>.md` (drop its first line) or edit it on GitHub. The workflow
  never overwrites an existing release.
- **Wrong commit, or a release that should not have been made:** do not move or reuse the tag; people and tools may
  already point at it. Publish the next version (`-beta.N+1`, or a patch version) from the right commit, and say in the
  wrong release's notes which release replaces it. Delete a release or tag only as a deliberate decision, and only
  before anyone has used it.
- **A bad change in production:** that is a deployment problem, not a release one. Roll back in Vercel (promote the
  previous production deployment) or revert on `main`; tag a new release once `main` is right.

## Deployments and migrations

- **Vercel** builds and deploys production from pushes to `main`, and previews from pull requests. A tag or a GitHub
  Release starts no build and no deployment, and no workflow in this repository reacts to tags: CI runs on pull requests
  and on pushes to `main`, and the other workflows are manual or scheduled. Check after the first tag push that Vercel
  shows no new deployment.
- **Migrations** are applied by a maintainer with `npm run db:migrate` (for production, the maintainer's migrate script),
  before or with the merge that needs them; a release never runs them. Every run re-applies every file, so run it from
  the commit being released or a later `main`, never from an older branch: an older set of files would put back older
  function definitions. Each release's notes name the migrations it contains, and any a self-hosted deployment must
  apply before upgrading.

## The SDK

[`@vestiarion/sdk`](https://www.npmjs.com/package/@vestiarion/sdk) lives in [`sdk/`](../sdk) and is versioned on its
own: `sdk/package.json` and `VERSION` in `sdk/src/version.ts`. A new version is packed with `npm run sdk:pack` into
`public/sdk/vestiarion-sdk-<version>.tgz`, committed, and published from that file by an owner of the npm organization
(`npm publish public/sdk/vestiarion-sdk-<version>.tgz --access public`), as [ARCHITECTURE.md](../ARCHITECTURE.md#developer-docs)
describes. On npm today: 0.1.0, 0.2.0 and 0.3.2 (0.3.0 and 0.3.1 were packed but not published).

An SDK version may be tagged `sdk-vX.Y.Z` on the commit whose tarball was published, once it is on npm; for 0.3.2 that is
`531cb1fb`, whose tarball matches npm's checksum. The release workflow refuses `sdk-v` tags: an SDK release is its npm
publish, and a product release notes the SDK version it ships with.

## The CLI

[`@vestiarion/cli`](https://www.npmjs.com/package/@vestiarion/cli), the `vestiarion` command, lives in [`cli/`](../cli)
and is versioned on its own, the same way as the SDK: `cli/package.json` and `VERSION` in `cli/src/version.ts`, which
`tests/cli-package.test.ts` holds equal.

1. Change `cli/`, raise both versions, and say what changed in `CHANGELOG.md`.
2. Run `npm run cli:pack`. It builds `cli/dist` and packs it into `public/cli/vestiarion-cli-<version>.tgz`, and refuses
   a version already packed. Commit the tarball in the same pull request; `tests/cli-package.test.ts` fails until the
   committed tarball is what `cli/` builds.
3. Once it is merged, an owner of the npm organization publishes that file, from the repository root on `main`:

   ```bash
   npm publish public/cli/vestiarion-cli-<version>.tgz --access public
   ```

   For the first version: `npm publish public/cli/vestiarion-cli-0.1.0.tgz --access public`. Check it with
   `npm view @vestiarion/cli version`; the registry can take a few minutes to show a new version.

The CLI depends on `@vestiarion/sdk` by a range (`^0.3.2` for 0.1.0), so the SDK version it needs must be on npm before
the CLI is published. The root `devDependencies` name the same range, and `tests/cli-package.test.ts` holds the two
equal. A CLI version may be tagged `cli-vX.Y.Z` on the commit whose tarball was published; the release workflow
refuses such tags, as it refuses `sdk-v` ones.
