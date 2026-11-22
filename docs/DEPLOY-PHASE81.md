# Phase 81 — Edge Meta AI: a light theme

## Run

Nothing to run: no SQL, no server change. The pages deploy on Netlify by themselves on merge.

## What changed

- **Light theme or dark theme,** switched in the account menu ("Light theme" / "Dark theme"), as in the Owner Assistant.
  - The choice is kept on the device (`ema_theme` in the browser's storage). Dark stays the default.
  - It is set in the page head before anything is drawn, so a light page never flashes dark.
  - The phone's status bar colour follows it.
  - It covers the sign-in screen, the bar, the chat and its figures, and the sheets (Overview, To-dos, Reports, Posts, Help).
  - Charts already in the chat redraw in the new colours.
- **How the colours work now:**
  - Every faint white tint and hairline in `app.css`, `meta-ai.css` and the ai page reads `rgba(var(--ink), alpha)`. `--ink` is white in `app.css` and black in the light theme.
  - The few dark-only text colours (bright white headings, the pale red, amber and green) read a token that only the light theme defines, falling back to the old value. Examples: `var(--strong, #fff)`, `var(--tone-bad, #fda4af)`.
  - The light palette is one block at the end of `meta-ai.css`.
- **The workspace is unchanged.** Only Edge Meta AI sets the light theme. Dark computes to exactly the old colours: compared element by element on the ai page, 239 elements, no differences.
- **Pages that still stay dark:** the Find customers and Local demand tools, and invoices, which open inside a sheet from the workspace.

## Check after deploy

1. https://ai.edgelead.online → account menu → **Light theme**. The page turns light, and the menu item now says Dark theme.
2. Reload: it stays light. Open Overview and Help: both are light.
3. Switch back to dark: it looks as it did before.
4. Open https://workspace.edgelead.online: it looks as it did before.
