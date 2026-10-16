export type SessionEntry = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  archived: boolean;
  bytes: number;
};
export type SessionInventory = { sessions: SessionEntry[]; revision: string; pendingCount: number };
export type CleanupResult = { selectedCount: number; restartRequired: boolean; errors: string[] };
export type SessionFilter = "all" | "active" | "archived";
export type CleanupConfirmation = { ids: string[]; revision: string; archivedCount: number; all: boolean };
