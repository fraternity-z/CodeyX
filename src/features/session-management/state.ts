import type { SessionEntry, SessionFilter } from "./types";

export const PAGE_SIZE = 20;
export function filterSessions(sessions: SessionEntry[], query: string, filter: SessionFilter) {
  const search = query.trim().toLocaleLowerCase();
  return sessions.filter(session => (filter === "all" || session.archived === (filter === "archived"))
    && (!search || [session.title, session.cwd, session.id].some(value => value.toLocaleLowerCase().includes(search))));
}

export function sessionDate(timestamp: number) {
  return timestamp > 0 ? new Date(timestamp).toLocaleString("zh-CN", { hour12: false }) : "时间未知";
}
