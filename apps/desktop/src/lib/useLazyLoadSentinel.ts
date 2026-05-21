import { useCallback, useEffect, useRef } from "react";

type FetchNextPage = (options: { cancelRefetch: false }) => Promise<unknown>;

type UseLazyLoadSentinelOptions = {
  enabled: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: FetchNextPage;
  rootMargin?: string;
};

export function useLazyLoadSentinel<TElement extends Element = HTMLDivElement>({
  enabled,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
  rootMargin = "320px 0px",
}: UseLazyLoadSentinelOptions) {
  const sentinelRef = useRef<TElement | null>(null);
  const fetchNextPageInFlightRef = useRef(false);

  const loadNextPage = useCallback(() => {
    if (fetchNextPageInFlightRef.current || isFetchingNextPage || !hasNextPage) {
      return;
    }

    fetchNextPageInFlightRef.current = true;
    void fetchNextPage({ cancelRefetch: false })
      .finally(() => {
        fetchNextPageInFlightRef.current = false;
      })
      .catch(() => undefined);
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  useEffect(() => {
    fetchNextPageInFlightRef.current = isFetchingNextPage;
  }, [isFetchingNextPage]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (
      !enabled ||
      !sentinel ||
      !hasNextPage ||
      isFetchingNextPage ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting || fetchNextPageInFlightRef.current) {
          return;
        }

        loadNextPage();
      },
      { rootMargin },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, hasNextPage, isFetchingNextPage, loadNextPage, rootMargin]);

  return { sentinelRef, loadNextPage };
}
