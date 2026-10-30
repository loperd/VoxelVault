---
name: Voxel Vault
description: A collector's cabinet for Minecraft-style chests, where the voxel world is the exhibit and the interface steps back.
colors:
  ground: '#0b0d0c'
  surface: '#121513'
  surface-raised: '#181c19'
  line: '#2a302b'
  text: '#eaeeea'
  text-muted: '#a7aea9'
  text-quiet: '#79817b'
  action: '#e8ebe8'
  action-ink: '#0b0d0c'
  coin: '#ffc83d'
  danger: '#e0685c'
  rarity-common: '#b9c2dc'
  rarity-uncommon: '#7aa7d9'
  rarity-rare: '#a99bd6'
  rarity-epic: '#e45cff'
  rarity-legendary: '#ffb02e'
typography:
  body:
    fontFamily: 'Geologica Digits, Golos Text, system-ui, sans-serif'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: 'Geologica Digits, Golos Text, system-ui, sans-serif'
    fontSize: '12px'
    fontWeight: 600
    letterSpacing: '0.08em'
rounded:
  hairline: '2px'
  tab: '3px'
  card: '14px'
  control: '8px'
  pill: '999px'
spacing:
  xs: '8px'
  md: '16px'
  lg: '28px'
components:
  button-primary:
    backgroundColor: '{colors.action}'
    textColor: '{colors.action-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.hairline}'
    padding: '12px 22px'
    height: '48px'
  button-secondary:
    textColor: '{colors.text}'
    typography: '{typography.label}'
    rounded: '{rounded.hairline}'
    padding: '12px 22px'
    height: '48px'
  filter-tab:
    textColor: '{colors.text-quiet}'
    typography: '{typography.label}'
    rounded: '{rounded.tab}'
    padding: '8px 14px'
    height: '40px'
  filter-tab-active:
    textColor: '{colors.action}'
    rounded: '{rounded.tab}'
  case-card:
    backgroundColor: '{colors.surface}'
    rounded: '{rounded.card}'
---

# Design System: Voxel Vault

## Overview

**Creative North Star: "The Collector's Cabinet"**

The product is a cabinet of objects: chests, their contents, the worlds they belong to. The block worlds (overworld, mine, end, relic vault) are the exhibit and carry all the colour and drama; the interface is the cabinet around them, dark, quiet and precisely made. Expensive here means restraint: hairlines instead of fills, one light-grey action colour instead of a brand accent, and every value stated exactly.

Case identity (the mine's orange, the end's violet) appears only in text and lines, never as a button fill. The same chest is shown at the same scale in every world (camera 9 blocks off) so the objects are comparable like items on a shelf.

**Key Characteristics:**

- Near-black green-tinted ground; the world image shows through a veil, it is never replaced by flat colour.
- One neutral action colour; rarity and currency are the only saturated colours outside the worlds.
- Small, sharp corners on controls (2-3px), generous 14px on cards that frame art.
- Uppercase, letter-spaced 12px labels for actions; sentence case for everything readable.
- Digits always set in Geologica; text in Golos Text (Cyrillic and Latin).

## Colors

A green-tinted near-black ground, three steps of tonal lift, and light grey as the only action colour.

### Primary

- **Cabinet Light** (#e8ebe8): the action fill and the active state of tabs and navigation. It is a light grey, not a brand hue.

### Secondary

- **Coin Gold** (#ffc83d): currency only (balance, prices).
- **Alarm Coral** (#e0685c): errors and destruction, in text, lines and glow; never a button fill.

### Neutral

- **Forest Black** (#0b0d0c): page ground and the ink on light buttons.
- **Cabinet Panel** (#121513): cards and panels; **Raised Panel** (#181c19) one step up.
- **Hairline** (#2a302b): borders and dividers.
- **Bright Text** (#eaeeea), **Soft Text** (#a7aea9), **Quiet Text** (#79817b): the three text tiers, all 4.5:1+ on the panel.
- **Rarity ramp** (common #b9c2dc, uncommon #7aa7d9, rare #a99bd6, epic #e45cff, legendary #ffb02e): a rarity keeps one hue on every screen.

### Named Rules

**The Neutral Action Rule.** Buttons are light grey (or a translucent white wash for secondary). A case's accent colour may colour a label or a line, never a fill.
**The Rarity Constancy Rule.** A rarity hue means the same class everywhere; do not reuse those hues for decoration.

## Typography

**Text Font:** Golos Text (with system-ui)
**Digits Font:** Geologica (digits 0-9 only, via unicode-range; so balances, prices and chances share one numeric voice)

**Character:** a clean grotesque for reading and a distinctly drawn numeral for data, set small and tracked out for actions.

### Hierarchy

- **Display** (bold, scene title, tight leading): the case name on the scene, large and left-aligned over the world.
- **Body** (400, 14px, 1.45): descriptions and notices.
- **Label** (600, 12px, 0.08em, uppercase): buttons and eyebrows.
- **Tab** (400, 12px, sentence case): filters and tabs, with a dimmed count.

### Named Rules

**The Numeral Rule.** Never set a number in the text face; digits come from Geologica automatically through the font stack.

## Layout

A centred column with wide side margins at desktop and a header rule, 16px base gap (8px small, 28px large). The scene page overlays text on the world: title block left, "last find" panel right, the open or return button bottom right, the item list below. At 390px the open button runs full width, the counter sits left, and the chest-features row wraps under the condition instead of clipping. Filter rows scroll horizontally on phones instead of wrapping.

## Elevation & Depth

Depth is tonal first: surfaces lift by colour (#121513 to #181c19) and a hairline, not by shadow. A soft drop with a top highlight (`0 8px 24px #00000099, inset 0 1px 0 #ffffff1a`) is reserved for buttons and modals. Over the world, a dark veil (top and sides) keeps text legible.

### Named Rules

**The Hairline Rule.** Separation is a 1px line at low alpha; no heavy borders and no hard offset shadows.

## Shapes

Controls are almost square (2px buttons, 3px tabs, 8px inputs) so they read as precise instruments; cards that frame item art are 14px. Corner brackets on archive cards echo a catalogue plate. Pills (999px) are for tags only.

## Components

### Buttons

- **Shape:** near-square (2px), 48px tall, 12px / 600 / uppercase with 0.08em tracking.
- **Primary:** light-grey gradient (#e6e8e6 to #bcc0bd), dark ink (#111412). Hover lifts 1px and brightens slightly; press scales to 0.97; a slow sheen sweeps across on hover (pointer devices only).
- **Secondary:** translucent white wash (#ffffff1f to #ffffff0f) with bright text; hover brightens.
- **Error context:** errors use the same fills; the red lives in the panel text and lines.
- **Focus:** 2px light outline, 3px offset.

### Filter tabs

- **Style:** borderless, transparent, quiet text, 40px tall, 3px radius; count at half opacity.
- **State:** active adds a hairline border (#a7aea92a), a faint wash (#a7aea909) and the action colour. Same language in the case directory and the archive.

### Cards

- **Case card:** 14px radius, #121513 fill, 1px hairline; hover changes border and fill only.
- **Item/archive card:** 4px radius, tonal gradient, inner 5px frame hairline, corner brackets.

### Navigation

Text tabs in the header, quiet by default, bright with a thin underline on the active one; the archive carries a dimmed count.

## Do's and Don'ts

### Do:

- **Do** let the world carry colour and keep the chrome neutral (#0b0d0c to #181c19, #e8ebe8 for action).
- **Do** show every chest at the same scale (camera 9 blocks off).
- **Do** use hairlines (#2a302b or lower alpha) to separate, and tonal lift to raise.
- **Do** keep touch targets at 40px or more.

### Don't:

- **Don't** fill a button with a case or error colour.
- **Don't** put a caption such as "ENDER CHEST" over the chest scene; the scene needs no brand label.
- **Don't** use the rarity hues as decoration or the coin gold for anything but currency.
- **Don't** use heavy shadows, hard offsets or gradients on text.
