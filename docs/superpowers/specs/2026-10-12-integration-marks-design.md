# Integration marks: Xero, QuickBooks Online and HubSpot

Date: 2026-10-12. Status: decided (autonomy grant 2026-10-05). Builds on the brand marks design
(`docs/superpowers/specs/2026-10-07-brand-marks-design.md`, M1-M4): every ruling there holds unless this says otherwise.

## Why

Vestiarion now connects to three tools a business already runs on: Xero and QuickBooks Online, whose bills come in for
review, and HubSpot, whose won deals come in to plan. A visitor who keeps the books in one of them should see it among
what Vestiarion works with, and a member connecting one in Settings should find its card at a glance. The marks stand
for integrations the code has (the Xero, QuickBooks and HubSpot connector designs of the same day) and never for an
endorsement.

## Decisions

- **I1 — the owners' files, unaltered.** Each mark is its owner's file, served byte for byte from `public/brands/` as an
  `<img>`, as in M3, and held to its SHA-256 by `tests/brand-marks.test.tsx`: Xero's wordmark in midnight
  (`xero.svg`), HubSpot's sprocket in its orange (`hubspot.svg`), and Intuit's QuickBooks lockup, the green "qb" circle
  beside "intuit quickbooks" (`quickbooks-lockup.svg`). The files were checked to hold plain paths and clip paths only:
  no script, no style that loads anything, no external reference.
- **I2 — QuickBooks shows its own marks; Intuit's alone is not shown.** The first kit had no QuickBooks logo, only
  Intuit's wordmark, and the first cut set that wordmark beside the words "QuickBooks Online". Once the partner supplied
  Intuit's QuickBooks lockup, QuickBooks shows its own marks instead: the lockup where a wordmark fits (the landing
  page), and its green "qb" circle alone as the symbol in small places (the Settings card's heading, the connect and
  launch pages). The Intuit wordmark on its own is not shipped: it stands for the company, not the product Vestiarion
  connects to, and set beside "QuickBooks" it would be a lockup of our own making. Intuit is named in words where it
  is meant: the trademark notice.
- **I3 — the one derived file: QuickBooks' circle.** The lockup draws the circle as two paths clipped to a 227.502
  square at (0, 27.6024). `quickbooks.svg` is those two paths, copied as they are, with that square as its view box:
  nothing recoloured, redrawn or moved. The test holds both paths to the lockup's text, character for character, and
  the file to nothing else. Intuit publishes the circle as QuickBooks' icon on its own, so standing alone is a use it
  makes itself.
- **I4 — Xero's wordmark in midnight.** Xero's kit has the wordmark in its bright blue, in midnight and in white, and no
  symbol apart from the word. Its own pairing sets the bright blue on midnight, so on Vestiarion's light grounds the
  midnight file is the one (15.8:1 on the page's ground, where the bright blue would be under 2:1). Cropping a mark out of
  the word is what M3 forbids, so the wordmark stands in the name's place, the name kept for screen readers, as npm's
  does.
- **I5 — HubSpot's sprocket, beside its name.** A symbol exists, and the symbol before the written name is how Arc,
  Circle, Slack and Telegram show; the HubSpot wordmark has no place that needs it, so it is not shipped.
- **I6 — no dark variants: the site has no dark theme.** Nothing in `src/` answers `prefers-color-scheme` or uses a dark
  variant, and every surface a mark sits on (the page's ground, a card's surface, the landing strip) is light. The
  white Xero, white HubSpot and white Intuit files are therefore not shipped, so a white mark never sits on white. The
  landing strip and the three Settings cards rendered with `prefers-color-scheme: dark` are pixel for pixel the light
  ones (checked for every screenshot below). The lockup's words are `currentColor`; drawn as an image they are black,
  which is right on every light ground. Inlining the SVG so they follow the text's colour would buy nothing until a
  dark theme exists, and would bring the lockup's clip-path ids into the page, where two marks would clash: if a dark
  surface ever needs it, inline it then with ids from `useId`. As images, each file is its own document and its ids
  never meet another's.
- **I7 — proportions.** Marks keep their owners' proportions; `BrandMark` takes a `scale` for the two whose letters fill
  their files. Symbols are 16 px in cards and headings and 24 px beside a page's h1. Xero's wordmark is drawn at three
  quarters of that, so its lowercase letters stand as tall as a name's capitals (42 x 12 at 16). QuickBooks' lockup is
  drawn so its circle is as tall as the other symbols (274 / 227.5 of the size). On the landing page its words would be
  5 px tall at that size, too small to read on a 1x screen, so the strip draws it with a 23 px circle (97 x 28) and
  lets it into the row's margins (`-mt-1.5 -mb-0.5`): the row keeps its 20 px and every card's text stays level.
- **I8 — the landing strip: eight services, never a row of one.** (The strip's layout, here and in I16, gave way on
  2026-10-16 to grouped cards: `2026-10-16-landing-integrations-design.md`. The marks, their sizes' reasoning and the
  notice stand.) "Built on, and works with" lists Arc, Circle, Xero,
  QuickBooks Online, HubSpot, Slack, Telegram and npm: two to a row up to 1024 px, four from there (rows of 4 + 4,
  never 3 + 3 + 2 or 5 + 3), with a rule above the second row and none before each row's first card. A name too long
  for half a phone's width moves under its mark instead of running into the line below. Checked at 1440, 1024, 768 and
  390 px, with no horizontal scroll at any of them.
- **I9 — the words.** Each new card says "Works with" and what it does, and links to its guide: Xero, "Bills come in for
  review; payments on Arc are booked back once approved."; QuickBooks Online, "Open bills from QuickBooks Online come in
  for review, sooner via webhooks." (the lockup says QuickBooks; the words say which one); HubSpot, "Won deals come in
  with their customers, to plan as collection schedules." The trademark notice adds "Intuit and QuickBooks are
  trademarks of Intuit Inc." and names Xero and HubSpot among the marks of their respective owners, still "not an
  endorsement". The FAQ's "Does it fit how we already work?" adds the bill list, Xero, QuickBooks Online and HubSpot.
- **I10 — where else.** Each tool's Settings card is headed by its mark, centred with Docs as Slack's is; each connect
  page puts the mark before "Connect Xero", "Connect QuickBooks" and "Connect HubSpot", held level with the heading's
  first line when it wraps on a phone (and before "Pick the Xero organisation"); each launch page heads with the mark
  and the name.
- **I11 — accessibility.** A mark is an image with an empty alt, hidden from assistive technology, beside its written
  name. Where it spells the name (Xero's wordmark, QuickBooks' lockup) the name is there for screen readers only, so
  nothing is read twice and nothing is missing. Measured against the page's ground and a card's surface: Xero's
  midnight 15.8:1 and 17.8:1; QuickBooks' green 3.0:1 and 3.4:1, its white "qb" 3.4:1 on the green; the lockup's black
  words 18.4:1; HubSpot's orange 3.0:1 and 3.4:1. Each is decoration beside its written name, so no contrast floor
  binds it, and the owners' colours are not ours to change.
- **I12 — the guides.** The guides have no place for a mark at the top (none of them shows one; Slack's and Telegram's
  show theirs through their Settings screenshots), so none was added. The three guides' Settings screenshots were
  photographed again with `npm run docs:screenshots -- xero-settings quickbooks-settings hubspot-settings`, so they show
  the marked headings.

## Tests

- `tests/brand-marks.test.tsx`: each file by its SHA-256; QuickBooks' circle as the lockup's own paths; the drawn sizes;
  every new mark the light-ground variant, with its measured contrast; no Intuit-only file; every connector its mark;
  a mark drawn only where its name is written; the wordmarks named for screen readers; the landing strip's eight
  services, links, grid, words and trademark notice; the FAQ's ways in.
- `tests/integration-marks.test.tsx`: the Xero, QuickBooks and HubSpot Settings cards, connect pages, the Xero
  organisation pick and the launch pages each show the mark beside the name.

## Screenshots

In `docs/superpowers/specs/integration-marks-shots/`, from a production build in headless Edge at a device scale of 2:
the landing strip at 1440 and 390 px (`landing-works-with-1440.png`, `landing-works-with-390.png`), and the Xero,
QuickBooks and HubSpot Settings cards at 1440 and 390 px through `/docs-shots` (`settings-<tool>-1440.png`,
`settings-<tool>-390.png`; at 390 the shot's fixed 760 px frame was let go to the viewport's width). Dark renders are
not committed: they are identical to these (I6).

## Not covered

- The connect and launch pages need a signed-in session, so they are held by render tests and were looked at once in a
  throwaway local page with the same markup, not photographed.
- Only Edge (Chromium) was used to look; the marks are plain images, so other engines should draw them alike.

## Asana and Pipedrive (2026-10-14)

Pipedrive and Asana shipped with their names alone (Pipedrive connector P20, Asana acceptance A1), until their owners'
files were in hand. The partner downloaded them from each company's brand kit; I1-I12 hold for them.

- **I13 — Pipedrive: its app icon in small places, its wordmark on the landing page.** `pipedrive.jpeg`, the kit's
  app icon (a white "p" on Pipedrive's green square, 200 x 200), heads the Settings card and the connect and launch
  pages, drawn edge to edge at 16 and 24 px as Arc's icon is. `pipedrive-lockup.svg`, the "pipedrive" wordmark in its
  dark grey (820 x 304, with 76 clear on every side, so `inset` 76 / 304), stands in the name's place on the landing
  strip, its letters 16 px from ascender to descender (70 x 16), the name kept for screen readers, as QuickBooks'
  lockup is there and its circle elsewhere. The kit's "p" letter logo is drawn in white (`#FFFFFF`; "dark" in its name
  means the ground it is for), so on the site's light grounds it would not show: it is not shipped (I6).
- **I14 — Asana: its logo everywhere.** `asana-lockup.svg`, the coral dots then "asana" in near-black (112 x 22), stands
  in the name's place on the landing strip, the Settings card and the connect and launch pages, the name kept for
  screen readers, as Xero's wordmark does. Its dots fill its height, so at `size` they stand as tall as the other
  symbols (81 x 16 in a card, 122 x 24 beside an h1), and its letters stand 11 px tall at 16, near Xero's 12. The
  kit's dots alone (`asana.jpeg`, 480 x 480) come on an opaque white square. Drawn at the symbols' size with its clear
  space pulled in, as Slack's is, the square showed as a 26 px white box on the cream ground, larger than the slot and
  past the column's edge; drawn edge to edge, the dots were 10 px, lighter than every other symbol. So it is not
  shipped. A transparent file of the dots from Asana's kit would take its place as the symbol in small places, at
  `aspect` 1.
- **I15 — Asana's file as it comes.** Its paths carry class names from Asana's website (`styles_logo-link__…`). The
  file has no stylesheet, and an `<img>` lets none in, so the fills draw as written: checked on its own in Edge at
  112 x 22, 102 x 20 and 224 x 44, coral dots and near-black letters on the page's ground, the card's surface and
  white. It has no `viewBox`; Edge scales it from its width and height to the size it is drawn at. It is served
  unaltered, held to its SHA-256 like every mark. Its title ("Asana Home") is not read out: the image has an empty alt
  and is hidden from assistive technology.
- **I16 — the landing strip keeps its rows.** Ten services, two to a row below 1024 px and five from it: Pipedrive's
  wordmark and Asana's logo sit in the 20 px row as Xero's does, centred on it, so every card's text stays level. Neither
  needs QuickBooks' larger drawing (I7): their letters read at the row's size. Checked at 1440 and 390 px, with no
  horizontal scroll, and with `prefers-color-scheme: dark` pixel for pixel the same as light (I6).
- **I17 — colours, measured.** Pipedrive's dark grey `#26292C` is 12.8:1 on the page's ground and 14.5:1 on a card's
  surface; its white "p" 5.7:1 on its green `#007737`. Asana's letters `#0D0E10` are 16.9:1 on the ground; its coral
  dots `#F06A6A` 2.6:1 on the ground and 3.0:1 on a card's surface, decoration beside the name (I11). The trademark
  notice on the landing page already named Pipedrive and Asana among the marks of their owners; the README's now names
  Asana too.

Tests: `tests/brand-marks.test.tsx` holds the three files to their SHA-256, their sizes, proportions and colours, that
the white "p" and the dots on white are not shipped, each connector's mark, the wordmarks named for screen readers, and
the landing strip's marks; `tests/integration-marks.test.tsx` the Pipedrive and Asana Settings cards, connect pages and
launch pages; `tests/pipedrive-render.test.tsx` the Pipedrive card's icon beside its name.

Screenshots, in `integration-marks-shots/`: `landing-works-with-1440.png` and `landing-works-with-390.png` taken again
with ten services, and `settings-pipedrive-<width>.png` and `settings-asana-<width>.png` at 1440 and 390 px through
`/docs-shots/pipedrive/settings` and `/docs-shots/asana/settings`. The Asana and Pipedrive guides have no Settings
screenshot and no place for a mark at the top (I12), so they are unchanged.
