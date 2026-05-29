"use client";

/**
 * Client-only React hooks.
 *
 * Import from here rather than `lib/utils` so server components can safely
 * import `lib/utils` without pulling in React hooks.
 */

import { useEffect, useRef, useState } from "react";

/**
 * Returns a debounced copy of `value` that only updates after `delay` ms
 * of inactivity. Use in client components to avoid firing expensive
 * operations (filter queries, API calls) on every keystroke.
 *
 * @example
 * const debouncedSearch = useDebounce(search, 300);
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState<T>(value);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    timerRef.current = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timerRef.current);
  }, [value, delay]);

  return debounced;
}
