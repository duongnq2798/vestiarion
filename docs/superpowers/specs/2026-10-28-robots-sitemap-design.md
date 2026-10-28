# robots.txt that names the sitemap

Date: 2026-10-28. Status: built.

## Problem

`/sitemap.xml` lists the public pages (`src/app/sitemap.ts`), but nothing pointed a search engine at it:

- `/robots.txt` answered 404 (the not-found page), so it named no sitemap.
- No sitemap had been submitted in Google Search Console for `sc-domain:vestiarion.xyz`.

Google found pages only through links. On Oct 28, a few hours after it went live, URL inspection of
`/payment-terms` said "URL is not on Google": Google did not know it, and no sitemap referred to it. The free tools
are meant to be found in search ("net 30 calculator", "ofac check"), so every day they stay unknown is lost reach.

## Decision

R1. `src/app/robots.ts` serves `/robots.txt` from Next.js's metadata route: one rule, `User-Agent: *` and `Allow: /`,
and `Sitemap: <public origin>/sitemap.xml`. The origin is `publicOrigin()`, the one the sitemap and every canonical
URL use (`https://www.vestiarion.xyz` on the production deployment).

R2. It disallows nothing. A missing robots.txt already allowed every crawler everywhere, so this changes no page's
crawl status. Pages kept out of search (the founder dashboard, the screening check, the shared link pages) say so with
`noindex`; a `Disallow` would stop the crawler from reading that tag, and a disallowed address that is linked from
elsewhere can still be listed without its content.

R3. `/robots.txt` needs no session (`requiresSession` is false for it), like `/sitemap.xml`, so a crawler never meets a
login redirect.

## Outside the code

Submitting `https://www.vestiarion.xyz/sitemap.xml` once in Search Console (Sitemaps) makes Google read it at once
instead of on its next fetch of robots.txt. That is a change to the team's Google property, made by the owner.

## Tests

`tests/robots.test.ts`: the sitemap line and its origin, the single allow-all rule with no `disallow`, no session for
either file, and every free tool in the sitemap it names.
