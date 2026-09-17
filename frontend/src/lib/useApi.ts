import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./api";

type State<T> = { data: T | null; loading: boolean; error: string | null };

/**
 * Minimal fetch-on-mount hook. Deliberately not a caching layer — this app has
 * no repeated cross-page queries that would justify one.
 *
 * `deps` drives refetching, exactly like useEffect's dependency array.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []): State<T> & { reload: () => void } {
  const [state, setState] = useState<State<T>>({ data: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    fetcher()
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof ApiError ? err.message : "Tidak dapat menghubungi server";
        setState({ data: null, loading: false, error: message });
      });

    // Prevents a slow response from a previous dependency value overwriting a
    // newer one (e.g. switching communities quickly).
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, reload };
}
