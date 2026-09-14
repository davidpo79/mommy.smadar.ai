import { useEffect, useState } from 'react';

/**
 * All styling in this app is inline (carried over from the prototype), so the
 * narrow layout is chosen in JavaScript rather than with a CSS media query.
 */
export function useIsNarrow(maxWidth = 760) {
  const query = `(max-width: ${maxWidth}px)`;
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (event) => setIsNarrow(event.matches);
    setIsNarrow(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return isNarrow;
}
