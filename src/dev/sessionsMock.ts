import type { SessionEntry } from "../features/session-management/types";

export function createSessionsPreview() {
  let revision = 1;
  let pendingCount = 0;
  let sessions: SessionEntry[] = Array.from({ length: 25 }, (_, index) => ({
    id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    title: index === 0 ? "管理面板功能开发" : index === 1 ? "已归档的界面方案" : `项目会话 ${index + 1}`,
    cwd: index % 2 ? "\\\\?\\UNC\\Server\\Share\\example" : "\\\\?\\E:\\code\\CodeyX",
    archived: index % 2 === 1,
    updatedAt: Date.UTC(2026, 9, 17, 8, index),
    bytes: 1024 * (index + 1),
  }));
  return (command: string, args?: Record<string, unknown>) => {
    if (command === "list_codex_sessions") return { sessions: [...sessions], revision: String(revision), pendingCount };
    const request = args?.request as { ids: string[]; revision: string; confirmed: boolean };
    if (!request?.confirmed || request.revision !== String(revision)) throw new Error("会话列表已变化，请刷新后重试");
    const selected = new Set(request.ids);
    const selectedCount = sessions.filter(session => selected.has(session.id)).length;
    sessions = sessions.filter(session => !selected.has(session.id));
    pendingCount += selectedCount;
    revision++;
    return { selectedCount, restartRequired: true, errors: [] };
  };
}
