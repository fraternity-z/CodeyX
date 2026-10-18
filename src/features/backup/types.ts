import type { ConfigSaveResult } from "../../App.types";

export type WebDavSettings = { url: string; username: string; passwordConfigured: boolean; allowHttp: boolean };
export type WebDavDraft = WebDavSettings & { password: string; clearPassword: boolean };
export type BackupSummary = { createdAt: string; routeCount: number; channelCount: number; settingsRevision: number };
export type RestoreResult = ConfigSaveResult & { recoveryPath: string };
export type BackupPreview = BackupSummary & { content: string; source: string };
