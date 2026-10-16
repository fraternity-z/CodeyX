import { useEffect, useState } from "react";
import { errorText } from "../../appUtils";
import { useOperationScope } from "../../useOperationScope";
import { sessionRequests } from "./requests";
import { filterSessions, PAGE_SIZE } from "./state";
import type { CleanupConfirmation, CleanupResult, SessionFilter, SessionInventory } from "./types";

export function useSessionsController({ active, isBusy, onRestart }: {
  active: boolean;
  isBusy: boolean;
  onRestart: () => void;
}) {
  const [inventory, setInventory] = useState<SessionInventory | null>(null);
  const [busy, setBusy] = useState<"" | "list" | "delete">("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<CleanupConfirmation | null>(null);
  const [revision, setRevision] = useState(0);
  const scope = useOperationScope(active);

  useEffect(() => {
    setConfirmation(null);
    setSelected(new Set());
    setInventory(null);
    setError("");
    setResult(null);
  }, [active]);

  useEffect(() => {
    if (!active || scope.pending) return;
    scope.invalidateReads();
    const valid = scope.read();
    let cancelled = false;
    const current = () => !cancelled && valid();
    setBusy("list");
    void (async () => {
      try {
        await sessionRequests.waitForPending();
        if (!current()) return;
        const next = await sessionRequests.list();
        if (current()) { setInventory(next); setPage(0); }
      } catch (cause) { if (current()) setError(errorText(cause)); }
      finally { if (current()) setBusy(""); }
    })();
    return () => { cancelled = true; };
  }, [active, revision, scope]);

  const blocked = !active || isBusy || !!busy || !inventory;
  const filtered = filterSessions(inventory?.sessions ?? [], query, filter);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function refresh() {
    if (!active || scope.pending || isBusy) return;
    scope.invalidateReads();
    setInventory(null); setSelected(new Set()); setConfirmation(null); setError("");
    setRevision(value => value + 1);
  }
  function changeQuery(value: string) { if (!scope.pending) { setQuery(value); setPage(0); setSelected(new Set()); setConfirmation(null); } }
  function changeFilter(value: SessionFilter) { if (!scope.pending) { setFilter(value); setPage(0); setSelected(new Set()); setConfirmation(null); } }
  function toggle(id: string) {
    if (blocked || !inventory?.sessions.some(session => session.id === id)) return;
    setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function toggleVisible() {
    if (blocked) return;
    const allSelected = visible.every(session => selected.has(session.id));
    setSelected(previous => {
      const next = new Set(previous);
      visible.forEach(session => { if (allSelected) next.delete(session.id); else next.add(session.id); });
      return next;
    });
  }
  function askRemove(all: boolean) {
    if (blocked || !inventory || scope.pending) return;
    const entries = inventory.sessions.filter(session => all || selected.has(session.id));
    if (!entries.length) return;
    setConfirmation({ ids: entries.map(session => session.id), revision: inventory.revision,
      archivedCount: entries.filter(session => session.archived).length, all });
  }
  async function remove() {
    if (blocked || !confirmation) return;
    const operation = scope.begin();
    if (!operation) return;
    setBusy("delete"); setError(""); setResult(null);
    try {
      const next = await sessionRequests.remove(confirmation.ids, confirmation.revision);
      if (operation.current()) setResult(next);
    } catch (cause) { if (operation.current()) setError(errorText(cause)); }
    finally {
      if (operation.finish()) {
        setBusy(""); setConfirmation(null); setInventory(null); setSelected(new Set());
        setRevision(value => value + 1);
      }
    }
  }
  return { inventory, busy, error, result, query, filter, page, pages, visible, filteredCount: filtered.length,
    selected, confirmation, blocked, refresh, changeQuery, changeFilter, toggle, toggleVisible, askRemove, remove,
    changePage: (value: number) => { if (!blocked) setPage(Math.max(0, Math.min(value, pages - 1))); },
    cancelRemove: () => { if (!scope.pending) setConfirmation(null); },
    restart: () => { if (active && !isBusy && !scope.pending && busy !== "list") onRestart(); },
  };
}
