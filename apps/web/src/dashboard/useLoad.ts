import { useCallback, useEffect, useState } from "react";
import { DashboardApiError } from "./apiClient";

export type Load<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string; status: number | null }
  | { kind: "ready"; data: T };

export interface LoadHandle<T> {
  /** Re-runs the loader. */
  reload: () => void;
  /** Replaces the loaded data in place, for a create/patch that already has the row. */
  update: (next: T) => void;
}

/**
 * One panel's data: loading, error, or ready.
 *
 * A 401 DELIBERATELY STAYS IN `loading`. By the time `apiFetch` throws one it has
 * already cleared the token, so the `RequireAuth` above this component is about to
 * navigate to login; rendering "Sesi Anda sudah berakhir" first would flash an
 * error the creator has no reason to read and cannot act on. `loading` is the
 * honest state for "a redirect is in flight".
 *
 * `update` exists so a create or a patch can show its result without a second
 * round trip — but note it takes the WHOLE next value, not a patch, so a caller
 * cannot half-update a list and leave the screen disagreeing with the server.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): [Load<T>, LoadHandle<T>] {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    load()
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof DashboardApiError && err.status === 401) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "terjadi kesalahan",
          status: err instanceof DashboardApiError ? err.status : null,
        });
      });
    return () => {
      cancelled = true;
    };
    // `load` is a fresh closure on every render, so it is deliberately not a
    // dependency — the caller's `deps` are what decide when to re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const update = useCallback((next: T) => setState({ kind: "ready", data: next }), []);

  return [state, { reload, update }];
}
