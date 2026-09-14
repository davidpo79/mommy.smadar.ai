import { useEffect, useRef } from 'react';
import { api } from './api.js';

/**
 * Keeps this browser in step with the database.
 *
 * Primary channel is a Server-Sent Events stream carrying the server's
 * revision counter, which PostgreSQL bumps (via trigger + NOTIFY) on every
 * mutation. A slow poll runs alongside it so a dropped or proxied-away stream
 * still converges. Neither channel carries data: they only say "you are
 * stale", and the client then refetches the canonical state.
 */
export function useSync({ enabled, getRevision, onStale }) {
  const handlers = useRef({ getRevision, onStale });
  handlers.current = { getRevision, onStale };

  useEffect(() => {
    if (!enabled) return undefined;

    let closed = false;
    let source = null;
    let pollTimer = null;

    const check = (revision) => {
      if (closed || !Number.isFinite(revision)) return;
      // Inequality, not growth: a restored database can move the revision
      // backwards, and this client is just as stale then.
      if (revision !== handlers.current.getRevision()) handlers.current.onStale();
    };

    const openStream = () => {
      if (closed || typeof EventSource === 'undefined') return;
      source = new EventSource('/api/mommy/events', { withCredentials: true });
      const read = (event) => {
        try {
          check(Number(JSON.parse(event.data).revision));
        } catch {
          /* ignore malformed frames */
        }
      };
      source.addEventListener('hello', read);
      source.addEventListener('change', read);
      source.onerror = () => {
        // EventSource reconnects on its own; nothing to do but let the poll
        // below cover the gap.
      };
    };

    const poll = async () => {
      try {
        const { revision } = await api.revision();
        check(Number(revision));
      } catch {
        /* offline or logged out - the next tick tries again */
      }
      if (!closed) pollTimer = setTimeout(poll, 20_000);
    };

    openStream();
    pollTimer = setTimeout(poll, 20_000);

    const onVisible = () => {
      if (document.visibilityState === 'visible') handlers.current.onStale();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(pollTimer);
      source?.close();
    };
  }, [enabled]);
}
