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
    text: '#eaf5ff',
    tint: '#38bdf8',

    // Core surfaces
    background: '#07111f',
    foreground: '#eaf5ff',

    // Cards / elevated surfaces
    card: '#0d1b2d',
    cardForeground: '#eaf5ff',

    // Primary action color (buttons, links, active states)
    primary: '#38bdf8',
    primaryForeground: '#062033',

    // Secondary / less-emphasis interactive surfaces
    secondary: '#13243a',
    secondaryForeground: '#cbd5e1',

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: '#1a2d46',
    mutedForeground: '#8aa3bd',

    // Accent highlights (badges, selected items, focus rings)
    accent: '#173d59',
    accentForeground: '#eaf5ff',

    // Destructive actions (delete, error states)
    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    // Borders and input outlines
    border: '#27425e',
    input: '#35516d',
  },

  // Border radius (in px). Sync from the sibling web artifact's --radius
  // CSS variable. This value applies to cards, buttons, inputs, and modals.
  radius: 8,
};

export default colors;
