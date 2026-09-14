import { useEffect, useState } from 'react';

const NARROW_MAX_WIDTH = 760;

const read = () => ({
  width: typeof window === 'undefined' ? 1280 : window.innerWidth,
  height: typeof window === 'undefined' ? 900 : window.innerHeight,
});

/**
 * All styling in this app is inline (carried over from the prototype), so the
 * narrow layout is chosen in JavaScript rather than with a CSS media query.
 * The height matters too: on a phone the week grid is scaled to the screen so
 * all seven days and all 24 hours fit without scrolling inside it.
 */
export function useViewport() {
  const [size, setSize] = useState(read);

  useEffect(() => {
    let frame = null;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSize(read()));
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    onResize();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  return { ...size, isNarrow: size.width <= NARROW_MAX_WIDTH };
}

export const DESKTOP_HOUR_PX = 34;
const MIN_HOUR_PX = 14;
const MAX_HOUR_PX = 26;

/**
 * Pixels per hour for the week grid. On a wide screen this is the prototype's
 * 34px. On a phone the 24-hour track is scaled to whatever is left below the
 * header, so the whole week and the whole day fit without scrolling inside the
 * board. `trackTop` is measured from the rendered grid; until it is known, the
 * viewport height alone gives a close enough first guess.
 */
export function hourHeightFor({ isNarrow, height }, trackTop = null) {
  if (!isNarrow) return DESKTOP_HOUR_PX;
  const available = (trackTop === null ? height - 300 : height - trackTop) - 8;
  // Kept to one decimal rather than a whole pixel: rounding 24 rows down to an
  // integer threw away up to half an hour of screen height.
  const perHour = Math.floor((available / 24) * 10) / 10;
  return Math.max(MIN_HOUR_PX, Math.min(MAX_HOUR_PX, perHour));
}
