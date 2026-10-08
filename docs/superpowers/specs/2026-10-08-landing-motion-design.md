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

## M2. The hero's signature: the chain, alive

A generative field behind the hero's right side: the ledger as a lattice of small blocks in an isometric wave. Every
couple of seconds one block is signed: it lights cobalt, a hash link draws to the block before it, the light runs a
short way down the chain and settles to jade. The newest block carries the live ledger head's sequence number, which
the page already reads (never a summary). It replaces the hero's two drifting blobs; the receipt and its arch stay in
front of it.

Canvas 2D, no new dependency: at most ~120 blocks, the device pixel ratio honoured, drawing stopped while the hero is
off screen or the tab is hidden, and the field fading to nothing under the headline so the words keep their contrast.

**Reduced motion.** One composed still frame; the newest block's glow breathes (opacity only, `data-calm-motion`
rules apply to its CSS equivalent).

## M3. Numbers, a demo with tabs, one strip and one wordmark

- **Count-up**: the open-numbers panels count up from zero the first time they come into view, once. Reduced motion:
  the final figure fades in. Screen readers always get the final figure.
- **Build on it**: a section with tabs, **API**, **SDK**, **MCP** and **GitHub**, each a real snippet from the docs
  (create an invoice; the typed client; adding the MCP server; `/bounty 25` on a pull request) typed into a terminal,
  then its real response shape, with a **Replay** control and a link to its guide. Reduced motion: the finished snippet,
  no typing.
- **One strip under the hero**: Built on Arc and Circle, works with Slack, Telegram, GitHub and npm, as a slow marquee
  (paused on hover and focus; static row under reduce).
- **Claims, once**: "Four claims you can check" folds into "Claims with receipts" as its first row, so the page has one
  claims section.
- **The footer's wordmark**: VESTIARION set very large across the footer, as the page's last image.

## Order

M1 with M0 first (the reference's most visible technique, and the policy every later piece relies on), then M2, then
M3, each its own pull request, each checked at 375, 520 and 1280 px, with motion on and with reduce on.

## Tests

Server-rendered markup for each piece: every step's words present, the diagram hidden from assistive technology, no
step dimmed in the server's HTML; a pure step-state helper (idle, active, done) tested directly. The motion policy is
read from `globals.css`: the reduce block lists the allowed transition properties and does not zero the duration.
Frames checked in a real browser with motion on and with reduce on.
