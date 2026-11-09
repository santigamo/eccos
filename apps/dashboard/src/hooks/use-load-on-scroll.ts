import { useEffect, useRef } from "react";

const LOAD_AHEAD = "400px 0px";

/**
 * Calls `load` when `sentinel` nears the bottom of `root`. Re-observing on every
 * new item is what keeps loading while a short page still leaves it in view.
 */
export function useLoadOnScroll<Root extends Element, Sentinel extends Element>(
  enabled: boolean,
  load: () => void,
  itemCount: number,
) {
  const root = useRef<Root>(null);
  const sentinel = useRef<Sentinel>(null);
  const latestLoad = useRef(load);
  latestLoad.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: itemCount re-arms the observer, see above
  useEffect(() => {
    if (!enabled || !root.current || !sentinel.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) latestLoad.current();
      },
      { root: root.current, rootMargin: LOAD_AHEAD },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [enabled, itemCount]);

  return { root, sentinel };
}
