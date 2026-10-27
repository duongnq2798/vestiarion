## Summary

<!-- What this pull request does, in a few sentences. Link the issue it closes. -->

## Why

<!-- The problem it solves, and who meets it. -->

## What changed

-

## Safety

<!-- What this can change about money, approvals, permissions or another workspace's data, and what stops it going
wrong. "None" if it touches none of them. -->

## Migration

<!-- None, or the new file in supabase/migrations/ and what it changes. A maintainer applies migrations. -->

## Tests

<!-- The tests added or changed and what each holds. Anything checked by hand, and how. -->

## Docs

<!-- The design in docs/superpowers/specs/, the guides, README.md, ARCHITECTURE.md, docs/self-hosting.md,
CHANGELOG.md, and content/docs/changelog.mdx for an /api/v1 or webhook change. -->

## Checklist

See [CONTRIBUTING.md](https://github.com/duongnq2798/vestiarion/blob/main/CONTRIBUTING.md#what-a-pull-request-needs).

- [ ] One focused change; a large one has an issue where the approach was agreed first
- [ ] Tests written first, and `npm run verify` passes
- [ ] A feature has a design in `docs/superpowers/specs/`, and its tests cite the design's rule ids
- [ ] Every affected doc is updated: `CHANGELOG.md` under `[Unreleased]`, and `content/docs/changelog.mdx` for an
      `/api/v1` or webhook change
- [ ] Generated files are regenerated and committed (`sdk:types`, `postman:build`, `quality-lab`)
- [ ] A schema change is a new numbered migration that is safe to run twice
- [ ] Screens use `src/components/ui` and follow `docs/design/visual-system.md`
- [ ] No secrets, personal data, local paths or private workspace names, in the code, the commits or this description
