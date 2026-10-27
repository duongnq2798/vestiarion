# Credit workspaces to the free tool they came from

Date: 2026-10-28. Status: accepted.

## Why

Vestiarion's free public tools are meant to bring businesses in: `/check-address` today, then a payment terms
calculator, a vendor check against OFAC's list and a bill list check. The team needs to see which tool brings in
workspaces that go on to use the agent, privately and from data it already keeps. Today it cannot:

- Google Analytics, when a measurement ID is set, counts each page view by its redacted path
  (`src/components/analytics/GoogleAnalytics.tsx`) and each click on a link marked `data-cta` (`cta_click`, the id
  matching `^[a-z][a-z-]{0,39}$`). That says how many people chose a tool's button, not whether a workspace followed.
- The first-touch cookie `vx_ft` (migration 0099, `src/lib/growth/attribution.ts`) credits a workspace, but `FirstTouch`
  writes it only when the address of the page that loads carries `utm_*` or `ref`. A tool's **Try it on your bills**
  goes to `/onboarding?shadow=1`, and a signed-out visitor is sent on to `/login?next=…` (`loginRedirectFor`), so a tag
  on that link is not on the address `FirstTouch` reads; even when it survives the sign-in link, the landing path it
  records is `/onboarding`, not the tool. A visitor who reached the tool without a tag is never credited at all.

## What

**TA1. One list of the free tools** (`FREE_TOOLS`, `src/lib/free-tools.ts`). Each tool has a slug, a path, a title and a
one-line description. The footer, the sitemap and the tool's start button read it, so the next tool is one entry.
- The slug is lowercase words and hyphens: it is the tool's `utm_source`, and `<slug>-start` is its button's `data-cta`,
  which must match `CTA_ID`.
- The path is the slug at the top level: public, never under `/tools` (which serves downloads).
- Today the list holds the address checker: `check-address`, `/check-address`, "Address checker". The payment terms
  calculator followed it (`payment-terms`, `/payment-terms`, "Payment terms calculator";
  `docs/superpowers/specs/2026-10-28-payment-terms-design.md`), its term pages listed after it in the sitemap.

**TA2. A tool's first touch** (`freeToolFirstTouch`). What the tool's start links keep:
- `utm_source` the tool's slug, `utm_medium` `free_tool` (`FREE_TOOL_MEDIUM`), `utm_campaign` `free_tools`
  (`FREE_TOOLS_CAMPAIGN`);
- `landing_path` the tool's path;
- the host of the site that linked to the tool's page, so search can be told from a post: only when it is another
  site's, by `FirstTouch`'s own rule (`referrerHost`), and only when the tool's page was opened straight from that
  site's link (`toolReferrer`): the browser's navigation entry for the page names the tool's page and is a fresh load,
  of type `navigate`. A move inside the site through the router loads no new document, so the entry and the referrer
  stay the first page's, and that site linked to that page, not to the tool. A reload, or a Back or Forward the browser
  did not keep in its cache, loads the tool's page again with the referrer of the history entry it returns to, which a
  move through the router shares with the first page, so the entry, of type `reload` or `back_forward`, is not trusted.
  In each case no host is kept;
- the time.

The slug, the path, the medium and the campaign are constants already in the cookie's alphabet
(`tests/free-tool-attribution.test.tsx` holds each slug and path unchanged by `sanitizeTag` and `sanitizePath`); the
referrer's host goes through `referrerHost`, which sanitizes it with `sanitizeHost`; and the server sanitizes every
value again when it reads the cookie (`parseFirstTouch`). It is written by `firstTouchCookie`: the same name, 90 days,
`Path=/`, `SameSite=Lax`, `Secure` on https. Nothing the person typed or pasted can reach it: the function takes the
tool, the referrer, the host and the time, nothing from the page's fields.

**TA3. The start links** (`ToolStartLink` and `ToolCta`, `src/components/public/ToolCta.tsx`).
- `ToolStartLink` goes to the landing's start (`TRY_HREF`, `/onboarding?shadow=1`). On a click, and on a middle click,
  which opens a new tab, it writes the tool's first touch, only when the browser holds no `vx_ft` yet: an earlier
  campaign keeps the credit, and nothing is ever overwritten.
- `ToolCta` is the tool's **Try it on your bills**: the primary button, a `ToolStartLink` with
  `data-cta="<slug>-start"`.
- Every start on a tool's page is a `ToolStartLink`: its button, and the full footer's **Get started** (TA5).
- Never on render, and it sends nothing. A browser that refuses cookies keeps none, raises no error and still follows
  the link.
- It is its own component, apart from the tools' checkers, which still never touch a cookie
  (`tests/check-address-page.test.tsx`).

**TA4. From free tools on /admin/growth** (`growthMetrics().fromFreeTools`). A tile beside **From counterparty pages**:
- customer workspaces whose first touch carries `utm_campaign` `free_tools`;
- of those, the ones with the agent's decision on a real bill, the dashboard's activation definition;
- the same two counts per `utm_source`, the tool, most workspaces first.

It is read from the attribution `growth_workspaces` already returns (migration 0099): no migration, no new column or
function. The Definitions section says where it comes from and what it cannot know.

**TA5. The footer and the sitemap.**
- The full footer has a **Free tools** group listing `FREE_TOOLS` by title. The address checker moves there from
  Resources.
- The group sits above Legal in the fourth column, so the footer keeps four columns at every width.
- A tool's page passes its slug to the footer (`<SiteFooter tool="<slug>" />`), so the Product group's **Get started**,
  the page's other start, is a `ToolStartLink` and credits the tool too. It looks and reads as on every other page, and
  takes no `data-cta`. A tool's page with the compact footer, which has no start link, needs none.
- The sitemap lists every free tool where `/check-address` was, after how the agent decides.

**TA6. /check-address.**
- Its button is `ToolCta` for `check-address`. The `data-cta` stays `check-address-start`, so its click counts stay
  comparable with those before. Its full footer is `<SiteFooter tool="check-address" />`.
- Under the introduction, one line, true whether a measurement ID is set or not: "The check runs in this page, and
  nothing you paste is kept. This page may count the visit and a click on Try it on your bills, by its address. What
  you paste or type is never sent." The last two sentences are `FREE_TOOL_COUNT_LINE`, for every tool.
- "may": without a measurement ID nothing counts the visit. "a click": the button's `cta_click`, with its name and the
  page's path. "by its address": the page is named by its path, never by what is on it.

**TA7. What the privacy page and the docs say.**
- The privacy page's cookie section says a free tool's **Try it on your bills**, or **Get started** at the foot of its
  page, sets the cookie too, when the browser holds none: the tool's name, `free_tool`, `free_tools`, the tool's page,
  the site that linked to the tool when the tool was opened straight from that link, and when. Its date is
  2026-10-28.
- ARCHITECTURE.md's growth tracking section and the changelog say the same.

## Not in this change

- The next tools themselves.
- Crediting a tool by the landing path of another campaign's first touch: a person who reached a tool from a tagged
  link stays that link's.
- A count of checks run. If one is wanted, it sends the tool's id only, from outside the checker's code.
- A tag on the start link's address: the cookie is written before the page is left, so a tag would add nothing.

## Limits

- As for every first touch, only a workspace opened in the same browser within 90 days is credited. A sign-in link
  opened in another browser loses it.
- A person who used a tool and came back later another way, without choosing one of its start links, is not credited
  to it. A start link on another page, such as the landing's, credits nothing, even right after the tool.
- Opening a start link from the browser's context menu is no click, so it writes nothing.
- A visitor who reached the tool from another of the site's pages is credited to it without a referring site, and so
  is one whose browser gives no navigation entry. So is one who reloaded the tool's page, or came back to it with Back
  or Forward, before choosing a start link, even when another site linked straight to it: the page cannot tell that
  load from one after a move through the router.
- Anyone can put `utm_campaign=free_tools` in an address, so a hand-made link counts too. The counts are a guide.

## Tests

`tests/free-tool-attribution.test.tsx`:
- the list: slugs, top-level public paths, CTA ids that analytics accepts (TA1);
- each tool's page names the tool to its full footer (TA5);
- a tool's first touch: exactly the allowed values, the referrer rules (another site's, and only on a fresh load of the
  tool's page, never a reload or a Back or Forward), the cookie's attributes, a round trip through `parseFirstTouch`
  (TA2);
- the button in a DOM: nothing written on render, the cookie written on a click and a middle click, never over an
  existing one, never on a right click, no referrer after a move inside the site, a reload or a Back or Forward, no
  error and the link still followed when cookies are refused, and no request in its code (TA3);
- the full footer's Get started in a DOM: it credits the tool on the tool's page, and nothing elsewhere (TA5);
- the growth tile from made-up workspaces: by `utm_source`, with the activation definition, customers only, other
  campaigns left out; its definition (TA4);
- the tile on the page, with its sentence, and the line on `/check-address` (TA4, TA6).

`tests/site-footer.test.tsx` and `tests/docs-content.test.ts` hold the footer group, the same footer links on a tool's
page, and the sitemap (TA5); `tests/check-address-page.test.tsx` the page's button, footer and line, and still no
cookie in the checker (TA6); `tests/legal-pages.test.tsx` the privacy page (TA7).
