# Design System: Mawjah — Multi-Market Trading Terminal

> Generated for Google Stitch. Use this file as the single source of truth when
> prompting Stitch to generate new screens, components, or layouts for Mawjah.

---

## 1. Visual Theme & Atmosphere

A high-density financial terminal designed for daily pre-session trading decisions.
The surface language is **OLED-depth dark** — surfaces so dark they read as true black
on high-contrast displays without using `#000000`. Every layer is fractionally lighter
than the one beneath it, creating a subtle Z-depth stack without explicit shadows.

The atmosphere is **clinical and focused**, like a Bloomberg terminal reimagined by
a product design team that cares about typeface. It is never "gamer dark" — no
neon borders, no saturated glows, no RGB contamination. The single accent color
(electric blue) is strictly reserved for interactive affordances and signal values.

**Design dials:**
- Variance: 8 — Asymmetric layouts, fractional grid columns, deliberate empty zones
- Motion: 6 — Fluid CSS spring physics, staggered reveals, perpetual micro-loops
- Density: 5 — Compact but not airless. Data breathes. Numbers have room to read.

**RTL support is first-class.** Arabic text (Noto Sans Arabic) is the co-primary
font for Saudi market content. All layout logic uses `padding-inline-start` and
`border-inline-start` instead of directional shorthands.

---

## 2. Color Palette & Roles

### Core Surfaces
- **OLED Void** (`#040507`) — Primary canvas. Main page background. Never pure black.
- **Depth Layer** (`#080a0f`) — Secondary background for inset areas: table headers, toolbars, nav insets.
- **Card Substrate** (`#0d0f16`) — All card and panel backgrounds. The "on-surface" level.
- **Hairline Border** (`rgba(255,255,255,0.06)`) — Default 1px separator between elements.
- **Lifted Border** (`rgba(255,255,255,0.09)`) — Borders on interactive or elevated components.

### Glass System
- **Glass Fill** (`rgba(255,255,255,0.03)`) — Background of ghost/secondary interactive elements.
- **Glass Border** (`rgba(255,255,255,0.07)`) — Border of glassmorphic surfaces (nav, drawers, modals).
- **Glass Shadow** (`0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 32px rgba(0,0,0,0.6)`) — Standard card shadow. The 1px top inset simulates edge refraction — this is the "Liquid Glass" technique.
- **Elevated Shadow** (`0 1px 0 rgba(255,255,255,0.06) inset, 0 20px 60px rgba(0,0,0,0.8)`) — Modals, drawers, and popover panels.

### Text Hierarchy
- **Primary Text** (`#e8eaf2`) — Body copy, table cells, labels. Slightly cool-white — never pure white.
- **Muted Steel** (`#6b7394`) — Secondary text: metadata, timestamps, sublabels, descriptions.
- **Ghost Ink** (`#363d58`) — Tertiary text: column headers, placeholder text, inactive states.

### Single Accent
- **Signal Blue** (`#3d8bff`) — The one and only accent. Used for: active states, CTA buttons, ticker symbols, focus rings, progress fills, links. Saturation is calibrated to sit comfortably against dark surfaces without glowing. **No purple associations. No gradients toward violet.**

### Semantic Signal Colors
These colors carry strict financial meaning. Do not repurpose them for decoration.
- **Confirmed Green** (`#00e676`) — Strong Buy signals, positive P&L, bullish regime, confirmed volume.
- **Lime Signal** (`#b9ff6e`) — Buy signals (one tier below Strong Buy).
- **Alert Amber** (`#ffd740`) — Watch signals, caution states, neutral regime.
- **Entry Orange** (`#ff9100`) — Avoid signals, warning states.
- **Exit Red** (`#ff3d71`) — Sell/Strong Sell, negative P&L, bear regime.

### Semantic Dim Surfaces (Tinted Backgrounds)
Each signal color has a matching 10–12% opacity fill for badge backgrounds:
- Green dim: `rgba(0,230,118,0.12)`
- Yellow dim: `rgba(255,215,64,0.12)`
- Red dim: `rgba(255,61,113,0.12)`
- Blue dim: `rgba(61,139,255,0.10)`

### Banned Colors
- Pure black `#000000` — use OLED Void instead
- Purple in any form (`#7c4dff`, `#8a74ff`, `#6c74ff`) — strictly forbidden
- Neon cyan, hot pink, or any oversaturated accent
- Warm grays — the entire palette is cool. Never mix warm and cool neutrals.

---

## 3. Typography Rules

### Font Stack
- **Display & UI:** `Geist` (Google Fonts) — primary Latin font for all interface text. Clean,
  technical, premium. Weights 300–900 available.
- **Arabic / RTL:** `Noto Sans Arabic` (Google Fonts) — co-primary for Saudi market content.
  When `dir="rtl"` is set, this becomes the first font in the stack.
- **Monospace:** `JetBrains Mono` (Google Fonts) — exclusively for: prices, scores,
  ticker symbols, timestamps, API keys, code. Weights 400/500/700.

### Scale Rules
- **Page headlines:** `clamp(40px, 5.5vw, 72px)`, weight 800, `letter-spacing: -3px`, `line-height: 1.02`
- **Section headings:** `clamp(28px, 3.5vw, 44px)`, weight 800, `letter-spacing: -2px`, `line-height: 1.1`
- **Card titles:** `18–22px`, weight 700, `letter-spacing: -0.4px`
- **Body copy:** `14–16px`, weight 400, `line-height: 1.65`, max-width `65ch`
- **UI labels:** `12–13px`, weight 500–600
- **Eyebrows / badges:** `10–11px`, weight 700, `text-transform: uppercase`, `letter-spacing: 1.2–1.5px`
- **Table data:** `13px` for names/text, `12px` JetBrains Mono for prices and scores
- **Column headers:** `10px`, weight 700, uppercase, letter-spacing 0.8px, Ghost Ink color
- **Base HTML font-size:** `14px` (rem values scale from this)

### Typography Don'ts
- **BANNED: Inter** — forbidden in all contexts. Use Geist.
- **BANNED: Generic serifs** (Times New Roman, Georgia, Garamond, Palatino) — forbidden everywhere.
- **BANNED: Gradient text on large headings** — text-fill gradients on H1 and H2 are forbidden.
- **BANNED: Oversized H1** — the first heading should not scream. Control hierarchy with weight and color contrast.
- Serif fonts of any kind are banned in dashboard and software UI contexts.

---

## 4. Component Stylings

### Buttons

**Primary (CTA):**
Shape: 8–9px border-radius, `height: 36–44px`, `padding: 0 16–22px`.
Fill: Signal Blue (`#3d8bff`). No gradient.
Inner highlight: `box-shadow: 0 0 0 1px rgba(255,255,255,0.12) inset` — simulates edge refraction, not a glow.
Hover: `opacity: 0.88`. Simple fade. No color shift.
Active: `transform: scale(0.98)` — tactile push feedback.
Disabled: `opacity: 0.4, cursor: not-allowed`.

**Secondary / Ghost:**
Background: `rgba(255,255,255,0.03)` (Glass Fill).
Border: `1px solid rgba(255,255,255,0.07)` (Glass Border).
Text: Muted Steel. Hover: lifts to Primary Text, border lifts to Lifted Border.

**Quick / Tinted:**
Tinted background using semantic dim colors (e.g., amber-tinted for attention actions).
Border in matching semantic color at 20% opacity.

### Cards — Double-Bezel Architecture

The signature Mawjah card system has two layers:

**Outer shell:** `background: rgba(255,255,255,0.025)`, `border: 1px solid rgba(255,255,255,0.07)`,
`border-radius: 16px`, `padding: 2px`. Hover: `transform: translateY(-1px)`.

**Inner core:** `background: Card Substrate (#0d0f16)`, `border-radius: 14px` (2px smaller than outer),
`padding: 14–16px`. `border-inline-start: 2px solid [semantic color]` — left edge accent varies by signal type.
Inner top highlight: `box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset`.

This creates a three-material sense of depth (border → inner ring → fill) with a single DOM element.

**When NOT to use cards:** For high-density table data, use `border-bottom: 1px solid rgba(255,255,255,0.04)`
row separators instead. Cards are reserved for summary metrics and widget-level components.

### Tables — Premium Data Surface

Container: Card Substrate background, Glass Border, 16px border-radius, `overflow: clip`.
Header row: Depth Layer background, sticky at `top: 56px` (header height), Ghost Ink text.
Body rows: `border-bottom: 1px solid rgba(255,255,255,0.04)`, hover at `rgba(255,255,255,0.03)`.
Selected rows: Signal Blue dim background `rgba(61,139,255,0.10)`.
Cell padding: `9px 12px`.

### Tabs & Filters

Tab group container: `background: rgba(255,255,255,0.025)`, `border: 1px solid rgba(255,255,255,0.07)`,
`border-radius: 10px`, `padding: 3px`. Inner highlight.
Active tab: Card Substrate fill, `box-shadow: 0 2px 8px rgba(0,0,0,0.5)`.
Inactive tab: transparent, Muted Steel text, hover at Primary Text.

### Badges & Pills

Signal badges: `padding: 3px 9px`, `border-radius: 20px`, semantic dim background + semantic text color,
`font-size: 10px`, weight 700, JetBrains Mono.

Eyebrow pills (like "Multi-market screener"): `background: rgba(61,139,255,0.10)`,
`border: 1px solid rgba(61,139,255,0.20)`, `border-radius: 20px`, Signal Blue text.

### Status Dots

Size: 6–7px circle. Colors follow signal semantics.
Active/running state: `animation: pulse 1.2s ease-in-out infinite` (scale 1↔0.8, opacity 1↔0.4).
Connected state: Confirmed Green with `box-shadow: 0 0 8px rgba(0,230,118,0.6)` — the one allowed inner glow, 
because it communicates live connectivity status.

### Navigation — Glassmorphic Bar

Height: 56px. `position: sticky; top: 0; z-index: 200`.
Background: `rgba(4,5,7,0.75)` (the OLED Void at 75% opacity).
`backdrop-filter: blur(24px) saturate(180%)`.
Bottom border: `1px solid rgba(255,255,255,0.07)`.
Shadow: `0 1px 0 rgba(255,255,255,0.03), 0 4px 24px rgba(0,0,0,0.5)`.

### Inputs & Forms

Label sits **above** the input. Never floating labels.
Background: Depth Layer. Border: Glass Border.
Focus: `border-color: Signal Blue`, `box-shadow: 0 0 0 3px rgba(61,139,255,0.10)`.
Error: `border-color: Exit Red`, `box-shadow: 0 0 0 3px rgba(255,61,113,0.10)`.
Shake animation on invalid submission: `translateX(-5px → +5px → -3px → +3px)` over 380ms.
Monospace font (JetBrains Mono) for API key inputs and financial data fields.

### Loading States

Use skeletal shimmer loaders that exactly match the target layout's dimensions.
No circular spinners ever.
Shimmer keyframe: `background-position: -600px 0 → +600px 0` over 1.6s ease-in-out infinite.
Background: gradient from Depth Layer → 4% white → Depth Layer at 1200px width.

### Empty States

Composed layouts that visually suggest how to populate the data — not just "No data yet" text.
Use Ghost Ink text, a subtle descriptive subline, and a single CTA button.

### Error States

Inline, below the affected element. Exit Red text, 11px, 1.4 line-height. `aria-live="polite"`.
Error state on the input field (border + glow), not just text below.

---

## 5. Layout Principles

### Grid Architecture
Use CSS Grid with fractional units. Never use `calc()` percentage flexbox math.

**Hero sections:** `grid-template-columns: 52fr 48fr` or `55fr 45fr` — slight left bias.
**Markets/feature grids:** `grid-template-columns: 3fr 2fr` or `2fr 3fr` — alternating rhythm between rows.
**Summary cards:** `grid-template-columns: repeat(5, 1fr)` — equal but compact.
**Feature bento:** `grid-template-columns: 3fr 2fr` with `grid-row: span 2` for tall feature cards.

**Max-width container:** `max-width: 1400px; margin: 0 auto`.
**Page padding:** `padding: 0 64px` on desktop, `0 40px` on tablet, `0 20px` on mobile.

### Hero Section Rules
- Centered Hero sections are **BANNED** — always use asymmetric split.
- Left column: headline, subtext, CTAs. Right column: visual/mockup.
- Headline is left-aligned. Never centered.
- Maximum one primary CTA button per hero.
- No "Scroll to explore", no scroll arrows, no bouncing chevrons.

### Spacing System
- Section vertical gap: `clamp(80px, 10vw, 120px)`
- Card internal padding: `14–32px` depending on component size
- Table cell padding: `9px 12px`
- Header height: `56px` (sticky reference for scroll offsets)
- Element gaps within components: `8–16px`

### Body Background
Fixed mesh gradient (two radial ellipses):
1. Blue tint at top-left: `ellipse 70% 45% at 10% 0%`, `rgba(61,139,255,0.06)`, fading to transparent at 60%
2. Green tint at bottom: `ellipse 50% 55% at 50% 105%`, `rgba(0,230,118,0.04)`, fading to transparent at 60%
These are `background-attachment: fixed` — they don't scroll with content.

### Overlap Rule
No overlapping elements. Every component occupies its own clean spatial zone.
No absolute-positioned content stacking on top of other content.

---

## 6. Motion & Interaction

### Easing Curves (CSS Custom Properties)
- `--ease-spring`: `cubic-bezier(0.32, 0.72, 0, 1)` — Used for: card hover lift, sidebar slides, spring-feeling UI.
- `--ease-out`: `cubic-bezier(0.16, 1, 0.3, 1)` — Used for: entrances, reveals, transitions. The default curve.
- `--ease-snappy`: `cubic-bezier(0.4, 0, 0.2, 1)` — Used for: tab switches, filter toggles, quick state changes.

### Scroll Reveal
All above-fold sections animate in via `IntersectionObserver` at `threshold: 0.08`.
Entry state: `opacity: 0; transform: translateY(22px)`.
Exit state: `opacity: 1; transform: translateY(0); transition: 0.65s var(--ease-out)`.
Stagger via `transition-delay`: first child 0s, second 0.08s, third 0.18s, fourth 0.26s.
Once revealed, `observer.unobserve()` is called — no re-trigger on scroll-up.

### Perpetual Micro-Animations
Active status dots: `pulse` keyframe — scale 1→0.8, opacity 1→0.4, 1.2s infinite.
Scan progress bars: fill from 0%→87%→87%→100%, hold, repeat over 3.5s.
Dashboard hero mockup: `float` keyframe — `translateY(0→-12px→0)` over 6s ease-in-out infinite.
AI analysis shimmer lines: alternating opacity 0.5↔1.0 over 2.4s, staggered 150ms per line.

### Table Row Animations
New scan results appear with staggered entry:
`opacity: 0; transform: translateX(-6px)` → full values.
`animation-delay: calc(var(--i) * 110ms + 800ms)` where `--i` is the row index.
Fill-mode: `both` — rows hold their final state.

### Hover Interactions
Card hover: `transform: translateY(-1px); box-shadow: 0 8px 32px rgba(0,0,0,0.4)` over 0.3s.
Button hover: `opacity: 0.88`. No color shift, no glow.
Button active: `transform: scale(0.98)` over 0.1s — tactile push.
Spotlight border effect on market/feature cards: CSS `radial-gradient` centered at
`var(--mx) var(--my)` (updated via `mousemove` event) at 6% opacity Signal Blue — reveals on hover.

### Performance Rules
- Animate exclusively via `transform` and `opacity` — never `top`, `left`, `width`, `height`.
- `will-change: transform` applied only to elements with perpetual loops (mockup float).
- Grain/noise textures on `position: fixed; pointer-events: none` pseudo-elements only.
- All perpetual micro-animations must be isolated in their own components (React) to prevent re-renders.

---

## 7. Special Patterns

### Glassmorphism (True Liquid Glass)
Beyond `backdrop-filter: blur(24px)`:
1. Semi-transparent background (`rgba(4,5,7,0.75)`)
2. `1px solid rgba(255,255,255,0.07)` border
3. Inner top edge: `box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset` — simulates physical edge refraction
The combination of the three layers is what makes it feel material, not just blurred.

### Auth Gate Overlay
Full-screen fixed overlay over the OLED canvas.
Split: 58% left (brand panel) / 42% right (form panel) on desktop. Single column on mobile.
Left panel: large logotype, Arabic brand mark (موجة), decorative market status rows.
Right panel: API key input, async validation, shake-on-error, upward-fade dismiss on success.
Transition: `opacity: 0; transform: translateY(-10px)` over 380ms `var(--ease-out)` on dismiss.

### Double-Bezel Card Accent System
The `border-inline-start` color on card inner cores encodes signal meaning:
- Strong Buy: Confirmed Green (`#00e676`)
- Buy: Lime Signal (`#b9ff6e`)
- Watch: Alert Amber (`#ffd740`)
- Sell: Exit Red (`#ff3d71`)
- Total/Neutral: Signal Blue (`#3d8bff`)

### Sector Badges
Each market sector gets a distinct tinted badge:
Banking/Tech: blue tint. Energy/Healthcare: green tint. Telecom/Equity: purple-free alternatives.
All use low-saturation background (12–15% opacity) with matching higher-opacity text.

---

## 8. Responsive Strategy

### Breakpoints
- `max-width: 1024px` — Collapse two-column hero and market grids to single column
- `max-width: 768px` — Collapse all multi-column layouts. Reduce padding to 20px. Hide decorative brand panels.
- `max-width: 480px` — Collapse stat bands and summary grids. Scale down font sizes via `clamp()`.

### Mobile-Critical Rules
- **Full-height sections:** Always `min-height: 100dvh`, never `height: 100vh` — iOS Safari catastrophic jump prevention.
- **No horizontal scroll** — any overflow on mobile is a critical failure.
- **Touch targets:** All interactive elements minimum `44px` height.
- **Asymmetric hero layouts:** Brand/visual panel collapses under text on `< 768px`. Text stays left-aligned.
- **Auth gate:** Brand panel (`display: none`) below 720px. Form panel takes full width.
- **Stat bands:** 4-column → 2-column → 1-column at respective breakpoints.
- **Typography:** All headlines use `clamp()`. Body text minimum `14px`.

---

## 9. Anti-Patterns (Strictly Banned)

### Visual
- No emojis anywhere — buttons, labels, content, alt text. Use SVG icons only.
- No pure black `#000000` — use OLED Void `#040507`.
- No neon outer glow box-shadows — only inner-border refraction and tinted diffused shadows.
- No oversaturated accent colors — Signal Blue is calibrated, not neon.
- No gradient text on H1 or H2 — control hierarchy via weight and color alone.
- No custom mouse cursors — performance and accessibility violation.
- No purple in any form (`#7c4dff`, `#6c74ff`, `#8a74ff`) — the AI purple aesthetic is permanently banned.
- No warm grays — the entire palette is cool-toned. Never mix warm and cool neutrals.

### Typography
- No Inter font — use Geist exclusively for Latin text.
- No generic serif fonts (Times New Roman, Georgia, Garamond, Palatino) — anywhere, ever.
- No oversized H1 that screams — size is one tool among many for hierarchy.
- No text overlapping images or other text.

### Layout
- No centered hero sections — always asymmetric split.
- No 3-equal-column card feature grids — use 2-column zig-zag or asymmetric bento.
- No `calc()` percentage flexbox math — use CSS Grid with `fr` units.
- No overlapping elements — every element has its own spatial zone.
- No `height: 100vh` for full-screen sections — use `min-height: 100dvh`.
- No horizontal overflow on mobile viewports.

### Content
- No filler UI text: "Scroll to explore", "Swipe down", scroll arrows, bouncing chevrons.
- No generic placeholder names: "John Doe", "Jane Smith", "Acme Corp".
- No round fake numbers: `99.99%`, `50%` — use organic messy data like `47.2%`, `+SAR 18.9M`.
- No AI copywriting clichés: "Elevate", "Seamless", "Unleash", "Next-Gen", "Empower".
- No broken image links — use `picsum.photos/seed/{string}/w/h` or inline SVG placeholders.
- No startup slop brand names: "Nexus", "SmartFlow", "PulseAI".

### Motion
- No linear easing on any animation — always use calibrated cubic-bezier curves.
- No `window.addEventListener('scroll')` for scroll animations — use IntersectionObserver.
- No animating `top`, `left`, `width`, `height` — transform and opacity only.
- No grain/noise effects on scrolling containers — only fixed `position: fixed` pseudo-elements.

---

## 10. Stitch Prompt Guidance

When using this DESIGN.md with Google Stitch, prefix your screen generation prompts with:

> "Using the Mawjah design system: OLED dark (#040507), Signal Blue accent (#3d8bff),
> Geist font, asymmetric layouts, double-bezel card architecture, no purple, no emojis,
> glassmorphic sticky nav."

Then describe what you want. Example:
> "...generate a virtual portfolio screen with a P&L summary, positions table, and
> a trade history timeline. Compact density, spring-physics hover on rows."

Stitch will inherit the color system, typography, and component patterns from this document.
