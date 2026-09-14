// The prototype expressed every style as a CSS string. Keeping those strings
// verbatim is the safest way to preserve the original design, so this turns
// them into the style objects React expects instead of rewriting them by hand.
const cache = new Map();

export function css(input) {
  if (!input) return undefined;
  if (typeof input !== 'string') return input;
  const cached = cache.get(input);
  if (cached) return cached;

  const out = {};
  for (const declaration of input.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (!property || !value) continue;
    out[
      property.startsWith('--')
        ? property
        : property.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    ] = value;
  }
  cache.set(input, out);
  return out;
}
