/**
 * tools/lib/theme.mjs — the theme axis.
 * HARNESS-AGENT-OWNED (ARCHITECTURE.md §1, §8).
 *
 * ART-DIRECTION §2 ships TWO appearances — "apron, daylight" and "apron,
 * night" — selected three ways: `:root` is light, `prefers-color-scheme: dark`
 * flips it, and `[data-theme]` overrides both. The review set and every
 * measurement gate captured exactly one appearance, so half of a ratified
 * design system was unreviewed and unmeasured.
 *
 * The three modes below drive all three selection paths:
 *   dark      media dark, no attribute    → the `prefers-color-scheme` branch
 *   light     media light, no attribute   → the `:root` default
 *   override  media dark + [data-theme=light] → the attribute must WIN
 *
 * `override` is not screenshot (it should look identical to `light`, and an
 * identical picture under a different name is the thing screenshot.mjs fails
 * on); it is measured by checkContrast.mjs, where "the attribute did not beat
 * the media query" shows up as a light-theme surface still carrying dark-theme
 * text colours.
 */

export const DARK = { key: 'dark', tag: '', scheme: 'dark', attr: null };
export const LIGHT = { key: 'light', tag: '-light', scheme: 'light', attr: null };
export const OVERRIDE = { key: 'override', tag: '-override', scheme: 'dark', attr: 'light' };

/** The screenshot axis: two appearances, one picture each. */
export const THEMES = [DARK, LIGHT];
/** The measurement axis: adds the attribute-override path. */
export const THEME_MODES = [DARK, LIGHT, OVERRIDE];

/**
 * Put the page in `theme`. Must be called AFTER navigation for the attribute
 * half (a fresh document has no `data-theme`); `emulateMedia` survives a
 * navigation but is re-asserted here so callers need only remember one call.
 *
 * Returns a fingerprint of what the CSS actually resolved to, so a caller can
 * report "the theme system does not reach this surface" from the cascade
 * rather than from a byte-identical PNG.
 */
export async function applyTheme(page, theme) {
  await page.emulateMedia({ colorScheme: theme.scheme });
  return page.evaluate((attr) => {
    const root = document.documentElement;
    if (attr) root.setAttribute('data-theme', attr);
    else root.removeAttribute('data-theme');
    // Force a style flush so the fingerprint below is post-cascade.
    void root.offsetWidth;
    const cs = getComputedStyle(root);
    const app = document.getElementById('app') || document.body;
    const acs = getComputedStyle(app);
    const tok = (n) => cs.getPropertyValue(n).trim();
    return {
      matchesDark: matchMedia('(prefers-color-scheme: dark)').matches,
      dataTheme: root.getAttribute('data-theme') || '',
      rootBg: cs.backgroundColor,
      appBg: acs.backgroundColor,
      appFg: acs.color,
      // §2's token names. Empty strings simply mean the tokens are not in yet.
      tokens: ['--ground', '--ground-deep', '--surface', '--fg', '--fg-mute', '--act', '--accent']
        .map((n) => `${n}:${tok(n)}`).join(' '),
    };
  }, theme.attr);
}

/** Do two fingerprints describe the same painted appearance? */
export function sameAppearance(a, b) {
  return !!a && !!b
    && a.appBg === b.appBg && a.appFg === b.appFg
    && a.rootBg === b.rootBg && a.tokens === b.tokens;
}
