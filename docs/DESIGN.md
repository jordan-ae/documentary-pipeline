# Design

The site's job: convince a technical hiring manager, in under three minutes,
that the person who built this has unusual judgment and unusual care.

Detail is the point — but detail means *correctness in hard places*, not
density. Every element must earn its place. Cut before adding.

## Anti-goals

Do not build any of these. They are the recognizable signatures of generated
design and they would undercut the entire premise.

- **Cream background (#F4F1EA-ish) + high-contrast serif + terracotta accent.**
  This is the obvious choice for a history project and the most common AI
  design tell in existence. Avoid it specifically.
- Near-black background with one acid accent colour
- Content chopped into identical rounded cards with the same soft grey shadow
- Tracked-out ALL-CAPS eyebrow labels above every heading
- Meta strings joined with middle dots (`A · B · C`)
- `→` appended to link text
- Numbered markers (01 / 02 / 03) on anything that isn't actually a sequence
- Fade-and-slide-up entrance animations on every section
- Hover lift/scale transitions on every card
- Animated counters, scroll-jacking, parallax hero
- Gradient washes used as decoration

## Direction: the critical edition

The subject is evidence and provenance. The most honest visual vernacular for
that is the **scholarly critical edition** — a text with its apparatus beside
it. Script in the main column, evidence entries in the margin, sources
accounted for.

This is subject-grounded rather than decorative: the layout *is* the argument
the project makes. The script column literally cannot render without its
apparatus, which is the whole thesis.

The pipeline replay is a second vernacular: an **edit timeline**. Stages laid
along a track, artifacts as the content of each stage. Reserved and technical,
not playful.

Confirm this direction before building. If you take a different one, it must
be equally grounded in the subject matter, and it must not be in the anti-goals
list.

## Tokens

Propose concrete values before writing CSS. Constraints:

- **Colour:** 4–6 named values. One accent, used sparingly and always to mean
  something specific (e.g. a verified-claim link). Never accent for decoration.
  Real black or real white is allowed; tinted near-blacks (#0B0B0B, #111) are
  a tell.
- **Type:** one or two families. If two, clearly distinct in structure, not
  two similar sans faces. Set a real type scale with intentional weights.
  Body line length under 80 characters.
  - **Tabular figures** (`font-variant-numeric: tabular-nums`) everywhere
    numbers align: timecodes, durations, run costs, evidence IDs. Without
    this, timecodes jitter as they change, and it's the first thing a careful
    reader notices.
  - Monospace only for things that are genuinely identifiers (run IDs,
    evidence IDs, model names). Not for small labels generally.
- **Layout:** state the alignment rationale. Asymmetric two-column with a
  margin apparatus is the proposed structure; make the columns real, not a
  sidebar bolted on.

## Motion

One orchestrated moment, not scattered effects.

The pipeline replay stepper is the place to spend it: advancing a stage should
show what changed. That's motion answering a user action, which is always
welcome. Everything else stays still.

`prefers-reduced-motion: reduce` must disable the stepper's transitions and
still leave it fully usable. Test it.

## Provenance as interface

The differentiating detail. Do not skip it.

- Every archival image displays source, license, and attribution. Not in a
  credits dump at the bottom — attached to the image.
- Every script sentence with a factual claim can reveal its evidence entries.
  Hover on desktop, tap on mobile.
- Claims sourced as `contested` render differently from `high` confidence, and
  the difference is explained once, plainly.
- The gate that caught something shows the rejected claim next to the evidence
  that failed to support it.

## Quality floor

Not optional, and this is where the "attention to detail" claim is actually
adjudicated.

**Real-data edge cases** — build with the longest real title, not a short one:
- A 90-character video title
- A scene with no matched image (the fallback hold)
- An asset with missing attribution (must fail visibly, never render blank)
- An evidence entry with no quote
- A script segment with zero claims

**Typography**
- Tabular figures on all aligned numerals
- Real em dashes, real quotation marks, non-breaking spaces before units
- No orphans in headings
- Consistent sentence case throughout; pick it and hold it

**Interaction**
- Visible keyboard focus on every interactive element, styled not suppressed
- Full keyboard path through the pipeline stepper
- Touch targets 44px minimum
- Video has real controls, captions track attached, poster frame set

**Rendering**
- Zero cumulative layout shift — reserve space for video and images
- Zero console errors or warnings
- No FOUC on fonts; preload and set `font-display`
- Loading states that name what is loading, not bare spinners
- Every image has meaningful alt text derived from the scene brief

**Responsive**
- Works at 360px. The margin apparatus collapses to inline disclosure on
  narrow screens — it does not disappear.
- Test at 360, 768, 1280, 1920

**Verification before calling it done**
- Open the deployed URL logged out, on a different network, on a real phone
- Run Lighthouse; fix anything below 90 on accessibility
- Tab through the whole site without touching the mouse

## Copy

Plain, active, specific. The interface's voice, not a person's.

- Name things by what they are: "Evidence", "Sources", "Rejected claim" — not
  "artifacts" or "pipeline outputs"
- No filler and no selling. The work argues for itself.
- Empty and failure states explain what happened and what to do, never
  apologize and never go vague
- One vocabulary throughout: if the stage is called "Evidence" in the stepper,
  it is "Evidence" everywhere

## The Chanel rule

Before shipping, look at each page and remove one thing. Restraint is the
signal you are actually trying to send.
