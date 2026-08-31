/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    // Legacy aliases (kept for backward compatibility)
    text: '#ffffff',
    tint: '#f5c518',

    // Core surfaces
    background: '#0a0a0f',
    foreground: '#ffffff',

    // Cards / elevated surfaces
    card: '#13131a',
    cardForeground: '#ffffff',

    // Primary action color (buttons, links, active states)
    primary: '#f5c518',
    primaryForeground: '#0a0a0f',

    // Secondary / less-emphasis interactive surfaces
    secondary: '#1a1a2a',
    secondaryForeground: '#cbd5e1',

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: '#22222f',
    mutedForeground: '#94a3b8',

    // Accent highlights (badges, selected items, focus rings)
    accent: '#2d5a2d',
    accentForeground: '#d8f3dc',

    // Destructive actions (delete, error states)
    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    // Borders and input outlines
    border: '#33333f',
    input: '#454557',
  },

  // Border radius (in px). Sync from the sibling web artifact's --radius
  // CSS variable. This value applies to cards, buttons, inputs, and modals.
  radius: 8,
};

export default colors;
