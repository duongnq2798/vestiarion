# Landing motion: a signature, a decision told by scrolling, and motion that respects the reader

Date: 2026-10-08. Follows `2026-10-08-landing-proof-design.md`. Direction A, chosen by the partner on 2026-10-08 after a
screen recording of a reference site (runware.ai).

## What the reference does, and what we take

The reference reads as crafted because of five things, not because it is dark:

1. **One signature visual** in the hero, alive the whole time (a generative 3D field).
2. **A system drawn and lit as you scroll**: a line diagram on one side, the steps on the other; the step being read
   lights its part of the diagram.
3. **Big numbers** with one line each.
4. **A product demo with tabs**: real code beside its result.
5. **One shape language and one accent**, repeated everywhere (cut corners, mono labels, a single green).

Vestiarion keeps its own language: ledger paper, cobalt for the agent, jade for proof, vermilion for refusal, receipts,
seals and hash links, the treasury's arch. We take the five techniques, not the look.

## Motion policy (M0, with M1)

Until now, under `prefers-reduced-motion: reduce`, every animation and transition was cut to 0.01 ms. A reader with
that setting saw a still page, and the partner's own machine has it on.

Reduced motion asks for no movement that can trouble the vestibular system: travel, scale, parallax, scroll-linked
movement. It does not ask for a page with no change at all. So:

- **Under reduce, transitions keep their duration for opacity and colours** (`opacity`, `color`, `background-color`,
  `border-color`, `fill`, `stroke`, `box-shadow`, `outline-color`) and lose it for everything else (transform,
  translate, size). The global rule sets `transition-property` to that list instead of zeroing the duration.
- **Keyframe animations stay cut** under reduce, except an element marked `data-calm-motion`, whose animation changes
  only opacity or colour (a slow glow). Each such animation is written to be calm: no movement, at least 2 s a cycle.
- **`Reveal` fades without lifting** under reduce, instead of doing nothing.
- Every moving piece below has a designed reduced state, described with it. A reader with reduce sees a page that
  changes as they read; it just does not move.

## M1. How a decision becomes an action, told by scrolling

The dark section keeps its words and gains the reference's second technique.

**Layout from `lg` up.** Two columns. Left: a line diagram of the loop, sticky under the header. Right: the five steps
(Observe, Reason, Enforce, Act, Sign), each a block with its number, name, title, words and sample, as today, spaced so
each takes about half a screen of scrolling. The step crossing the middle of the viewport is the active one: it is at
full strength and the others are dimmed; in the diagram, its part lights, the parts before it stay lit as done, and
the parts after it rest unlit.

**The diagram** (SVG, decoration only, `aria-hidden`):
- Observe: the five domains as tiles across the top, dotted lines converging on the book.
- Reason: the model's node, cobalt, with `{ action: "pay", confidence: 0.81 }`.
- Enforce: the code's gate, drawn as a small arch (the treasury's), with three rules. Two outputs leave it: *allowed*
  down to Act, *refused* along the side straight to Sign, so the drawing says refusals are kept.
- Act: Circle on Arc, with a confirmed chip.
- Sign: four hash-linked entries; the newest arrives when Sign is active.
- Connectors: the path into the active node carries a pulse of light from the node before it.

**Reduced motion.** No pulse and no arriving entry: the active path and node change colour (an allowed transition),
and the newest entry fades in.

**Below `lg`.** No sticky diagram: the five steps stack, each with its own sample, and light as they reach the middle
of the screen. At every width a rail runs down the steps' left edge, a node per step: jade once read, cobalt with a
halo for the step being read.

**Without script.** The server's HTML shows every step at full strength and the whole diagram lit; nothing is hidden
and nothing depends on the script to be read. The script only dims what is not being read.

**Words.** Unchanged from today's section, so the claims stay those already reviewed.

## M2. The hero's signature: the arch, alive with the receipt

Ruling, on seeing the hero at 1440 px: the hero already has its signature, the treasury's arch around the printing
receipt. A generative field behind it would compete with both, so the arch itself comes alive instead, in time with the
receipt, which makes the motion mean something.

- **The arch's light** (`ArchLights`, from `xl` up where the arch is drawn): while the receipt is observed and
  reasoned, a light climbs the twelve stones from the left springing over to the right, each brightening and settling
  to a tint; when the receipt is signed, the keystone rings in its outcome, jade for a payment, vermilion for a
  refusal. A new receipt starts it again; it pauses with the replay.
- **One clock.** The replay publishes a beat (`hero/replay-beat.ts`) each time a receipt starts printing, is paused or
  goes off screen, carrying the time its first line's animation started (`getAnimations()`), since the first receipt
  prints from the page's styles before the script runs. The light moves its delays back by the time already elapsed.
- **Reduced motion.** The receipt still prints, as calm motion: each line fades in where it stands, the stage being
  worked on still lights, and there is no wipe, scan or turning stamp. The replays still change by themselves, so the
  pause control shows under every setting. The arch's light changes only opacity and colour, so it runs as it is.
- **Calm motion reaches inside.** The global rule spares an element marked `data-calm-motion` and everything inside
  it, so a container can say it once.

## M3. Numbers, a demo with tabs, one strip and one wordmark

- **Count-up**: the open-numbers panels count up from zero the first time they come into view, once. Reduced motion:
  the final figure fades in. Screen readers always get the final figure.
- **Build on it**: a section with tabs, **API**, **SDK**, **MCP** and **GitHub**, each a real snippet from the docs
  (create an invoice; the typed client; adding the MCP server; `/bounty 25` on a pull request) typed into a terminal,
  then its real response shape, with a **Replay** control and a link to its guide. Reduced motion: the finished snippet,
  no typing.
- **No marquee.** Ruling while building M3: "Built on, and works with" stays a row of five, because each entry's line
  and link (see the payments, read the guide) would be lost in a marquee. (Since 2026-10-16 the tools are grouped cards,
  `2026-10-16-landing-integrations-design.md`; still no marquee.)
- **Claims, once**: "Four claims you can check" folds into "Claims with receipts" as its first row, so the page has one
  claims section, and the four claims sit two by two, each card with its receipt, instead of one per screen.
- **The footer's wordmark**: VESTIARION set very large across the footer, as the page's last image.

## M4. Foundation and budget

Added 2026-10-19, the first part of making the decision itself move on the landing (the bill checks itself, a rule
holds it, the proof checks itself). Before any of that moves, the page gets one set of rules, a fix for content that
stayed hidden, and the bytes to pay for it.

**Rules every moving piece keeps.**
- It plays once, when it is first seen, and is done within 2.5 s. Nothing on / repeats forever at rest; a loading
  placeholder's shimmer, shown only until its figures arrive, is the one exception.
- Nothing is hidden in the server's HTML: no inline `opacity: 0`, nothing drawn only by the script. The hidden state is
  set by the script, on what starts below the fold, so a page whose script never runs shows everything.
- The H1, the lede and the calls to action never move.
- Under reduce, a sequence still shows, in the same order, by fade and colour only: a transition (which the M0 rule
  keeps for opacity and colours), or a keyframe animation inside `data-calm-motion`.
- An animation driven by scrolling (`animation-timeline`) sits only inside `@media (prefers-reduced-motion:
  no-preference)`: the M0 rule shortens keyframe animations, which does not stop a scroll-driven one.

**Content jumped past.** `Reveal` watched for its element inside the viewport only, so a block the reader jumped past
(the header's link to Proof, the End key, a fast scroll) was never seen and stayed at opacity 0 until scrolled back to:
measured at 1440 px, Safety's and Integrations' blocks after End. Its observer's margin now reaches 100,000 px above
the viewport, so a block above it counts as seen, and one first seen there is shown at once, as the server drew it,
with nothing left to fade out of sight. `CountUp` does the same, so a figure jumped past is never left at zero.

**Sequences.** `<Reveal sequence>` leaves the element where it is and brings in its children marked `seq` one by one,
in the order they are written: each from opacity 0 and 8 px lower, over 420 ms, `--stagger` after the one before
(60 ms, `stagger` to change it; `MOTION.stagger` in `tokens.ts` mirrors it). Under reduce the items fade in where they
stand, in the same order. Nothing on the landing uses it yet; the pieces that follow do, and /design shows it. What
`Reveal` and `CountUp` hide when the page hydrates is hidden at once, and only the arrival is animated: the hiding used
to run on each item's own delay, so a sequence reached within half a second of load came in backwards, its last items
still fading out while the first came back (measured on /design at 1280 × 900 under reduce: items at 0.01, 0.18, 1 and
1 just after hydration; now all at 0, then in order).

**Still at rest.** The hero's two tints no longer drift. The drift moved them 1 to 2 % under a heavy blur, too little
to see, and kept two blurred layers of about 30 rem painting for as long as the page was open. After it, no animation
runs on / once the page has loaded (`document.getAnimations()`: 2 running, both infinite, before; none after).

**The tab marker.** The shared `Tabs` glide their marker through Motion's layout animation, which needs
`MotionProvider`; the landing never mounted it, so the marker under "Who it's for" and the developer snippets jumped.
Mounting it costs Motion's layout features: bundled and minified, Motion as `Tabs` uses it today is 7.9 KB gzip, and
with `LazyMotion`, `MotionConfig` and `domMax` 42.8 KB, 34.9 KB gzip (31.0 KB brotli) more, over the 30 KB this budget
allows for one marker. So the landing keeps the shared `Tabs` as they are and glides the marker in CSS
(`useTabGlide`, `[data-glide]` in landing-hero.css): the chosen tab draws the marker as the server does, the script
tells it where the last one stood, and it moves there by its edges over 240 ms (`--ease-standard`), under the other
tabs' names. Under reduce the animation is cut and the marker moves at once, the reduced state the developers spec
names.

**Prefetch.** Next prefetches each link as it scrolls into view. On production (2026-10-19, 1440 × 900, a steady scroll
to the bottom, cold cache), a full scroll made 49 prefetches, 626 KB of 1.10 MB, and 570 KB of it was the docs and
guides; at 390 px, 625 KB and 569 KB. The landing's links into /docs, in its sections, header and footer, now set
`prefetch={false}` (`landingPrefetch`), so those pages load when opened; the call to action, sign-in, /how-it-decides
and the other pages keep theirs (56 KB). The menu's links prefetch only once it is opened.

**The open numbers.** A counted figure changed width as it counted, shifting what is beside it (a cumulative layout
shift of 0.0001 at 1440 px and 0.0005 at 520 px). The final figure, unseen, now holds the width the count runs in, the
digits are even-width, and the count starts where the figure starts: 0 at both widths. A figure under 10 fades in
(300 ms) instead of counting, since counting to 4 is four jumps, and under reduce every figure fades in where it
stands, as M3 says.

**The sample bill checks itself.** The headline promises that every bill is checked before it is paid, and the sample
bill beside it (`hero/BillPreview.tsx`, still a server component) now shows it happen, once, the way the agent works
through a bill, with the receipt's print. Its frame and title are there from the first frame, so it is never an empty
box. Then, in ms from its start (`BILL_PRINT_AT` in `hero/scenarios.ts`): the payee prints at 120 and the amount at
200; the reasoning's tint opens at 380 and its words print at 460; the four checks print at 560, 680, 800 and 920,
each tick drawing 140 ms after its row, short stroke first, then turning from grey to green; only once the last tick
has landed is "Agent proposes: pay it" stamped, at 1480 (from 1.12 times its size and transparent, over 300 ms, with no
turn, unlike the receipt's seal), so the card says what the headline does: checked first, then proposed. "Waiting for
your verdict" prints at 1540, and its dot breathes once from 1560 (a 3 px ring, 400 ms), over before the held bill is
stamped; the question and its drawn buttons print at 1620; the next bill, Kestrel Design, at 1720; "Held for you" is
stamped at
1960; "Blocked by code, not by the model" prints at 2060, and its shield turns amber at 2160. A line prints as the
receipt's do (`replay-print`: opacity, a wipe down and 3 px of travel, over 420 ms). The last part ends at 2,480 ms,
and nothing repeats. That is 20 animations, of opacity, clip, scale, a grey filter lifting, the tick's stroke and the
dot's ring only, so nothing in the layout moves. The colour turns are a `grayscale` filter and the dot's breath a ring
scaled out from under it, so the compositor runs them; only the tick's stroke is drawn on the main thread, as a tick
drawn by hand needs it. Each fills backwards only: its last frame is the part's own style, so once played it lets go,
and nothing is left held or on a layer of its own. The H1, the lede, the calls to action and Invoice Capture do not
move at all.

**When it plays.** From 1024 px the card sits beside the headline, and the print is CSS from the page's first paint,
so it runs before the script and without it, and ends with the whole card. Below that the card sits under the text,
and its top is often at the bottom of the first screen or below it (at 520 × 900 from 752 px, at 412 × 915 from 846,
at 390 × 844 from 867), so nothing prints from the first paint there: a page whose script never runs shows the card
whole, and none of it plays unseen while the page loads. A first version printed from the first paint at every width
and held a card only when its first line was below the viewport: at 520 × 900, 412 × 915, 430 × 932 and 768 × 1024 the
checks, the verdict and the held bill then printed below the fold and were done before the reader got there, and at
390 × 844 the whole print ran unseen until hydration, slowing it. `PrintOnView` (`hero/PrintOnView.tsx`) decides by
line instead. When the page hydrates, each line still below the viewport (every line, in a tab not shown yet) waits
unseen (`data-print="wait"`: no animation, opacity 0), and each prints once it comes into view (`go`, from its first
pixel in the viewport: held in the bottom 8 %, where `Reveal` holds a block, it would leave a gap in the card the
reader can see). The lines print in the order of the work: one never goes before a line the agent reaches first, so
"Waiting for your verdict", in the proposal's row, waits until the checks below it are in view. Their moments count
from the first of them to print, so the card goes on where the reader is looking; a line reached after its moment
prints at once, and the ones after it keep their spacing. A line the reader jumped past is set to `done` and shown
whole. Lines already on screen when the page hydrates are left as they are, printing beside the headline (`go`) or
whole below it (`done`), so nothing the reader has seen vanishes, and a window that later crosses 1024 px does not
print them again. The proposal's row (`data-late`) is the one exception: it sits above the checks but comes after them,
so at 520 × 900 it would be on screen, whole, before any check had printed. Below 1024 px it is not there at the first
paint, waits with the lines after the checks, and fades in on its own at 2.5 s if the script never runs.

**Under reduce** the card asks for calm motion (`data-calm-motion`): each part fades in where it stands
(`replay-fade`), in the same order and at the same moments, the stamps without growing; the ticks appear with their
rows and only turn from grey to green, the shield turns amber, and the dot does not breathe. Each part changes once
and stays; nothing flashes.

**The way to the real one.** Under the caption, a plain link, "See a real decision and its transaction"
(`data-cta="hero-proof"`), leads to the proof's real payment, so the sample's next step is the record it stands for.

Measured on the dev server in headless Edge (2026-10-19), with each animation of the card seeked to 0, 400, 1200 and
2500 ms of the print, at 1440 × 900, 520 × 900 and 390 × 844, with motion and with reduce, and with JavaScript off: the
card and the hero's text keep their boxes from the first frame to the last, layout shift is 0 at every size, the last
animation ends at 2,480 ms, and none is running 3 s later. At 1440 px, the first look at the page found the print
160 ms in, before the page had hydrated. In a running browser the print starts 30 to 50 ms before the first contentful
paint, as the receipt on /how-it-decides does in production; only the first page a freshly started browser draws, or
one traced with screenshots, showed a gap of about 400 ms. Scrolling by wheel, 100 px every 250 ms, at 390 × 844,
412 × 915, 430 × 932, 520 × 800, 520 × 900, 768 × 1024, 1024 × 700 and 1440 × 900, with motion and with reduce: no line
started printing below the viewport; a line waited in view only behind one the agent reaches first (the wait for a
verdict, until the checks below it were seen) or inside a line still printing in; and `document.getAnimations()` was
empty 3.5 s after the last line. Before the parts filled backwards only, 19 finished animations stayed there, and at
rest the page had 30 compositor layers, 21 of them the card's; now 9, none of them the card's. In the 2.6 s after the
first contentful paint at 1440 × 900, the page's main-thread render work fell from 630 to 700 ms to 480 to 560 (60 to
90 without the print), and its paints from about 710 to about 300, once the colour turns and the dot ran on the
compositor; the ticks' stroke is most of what is left (about 200 ms), and no long task comes with it. At 520 × 900 under reduce, and at 390 × 844 with
the CPU slowed 4 times, nothing prints while the page loads (5 to 11 main-thread frames). With JavaScript off the card
is whole 3 s after load at all three sizes. No capture script in the repository photographs the hero:
`docs:screenshots` and the marketplace images shoot `/docs-shots`, and the social image is drawn by `next/og`.

## Order

M1 with M0 first (the reference's most visible technique, and the policy every later piece relies on), then M2, then
M3, each its own pull request, each checked at 375, 520 and 1280 px, with motion on and with reduce on.

## Tests

Server-rendered markup for each piece: every step's words present, the diagram hidden from assistive technology, no
step dimmed in the server's HTML; a pure step-state helper (idle, active, done) tested directly. The motion policy is
read from `globals.css`: the reduce block lists the allowed transition properties and does not zero the duration.
Frames checked in a real browser with motion on and with reduce on.

M4 adds (`tests/motion-policy.test.ts`): every section / renders, rendered as the server does, uses no class whose
animation repeats forever, read from the stylesheets, except the loading placeholder's; and `animation-timeline`
appears only inside `prefers-reduced-motion: no-preference`. `tests/ui-motion.test.tsx` and
`tests/landing-count-up.test.tsx` run `Reveal` and `CountUp` in a DOM: hidden below the fold, shown when seen, shown at
once when jumped past, a sequence numbered in order, and nothing hidden in the server's HTML; motion-policy also holds
their CSS to animating only an arrival, and checks its own reading of a component's scroll-driven class wherever the
class sits in its list.
`tests/landing-prefetch.test.tsx` holds every docs link on the landing to `prefetch={false}`.
`tests/landing-bill-print.test.tsx` holds the sample bill: every line in the server's HTML, with no inline opacity, no
hidden attribute and no print state; `BILL_PRINT_AT` in the order of the work; each moving part's moment taken from it
and its length read from landing-hero.css, all of them done by 2.5 s; the stamp with no turn and the dot breathing
twice, by scale and opacity, and the colour turns by a filter; every part filling backwards only; nothing printing
from the first paint below 1024 px; the reduce rules fading and turning colour only; and `PrintOnView` in a DOM: a
card on screen left as it is, marked whole, or printing on at its own moment; only the lines below the viewport held,
each printed once in view with its moment counted from the first to print, none before a line the agent reaches
first, one reached late printed at once with the spacing after it kept, lines jumped past shown whole, and every line
in a hidden tab printed once the tab is shown.
