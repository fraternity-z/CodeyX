import { invoke } from "../../api";
import type { ExtensionTransport, Inventory, Scope, SkillCacheInventory } from "./types";

export const extensionRequest: ExtensionTransport = request => invoke("codex_extensions", { request });
const pendingMutations = new WeakMap<ExtensionTransport, Promise<unknown>>();

export function waitForExtensionMutation(request: ExtensionTransport) {
  const pending = pendingMutations.get(request);
  return pending ? withTimeout(pending.catch(() => undefined)) : undefined;
}

export function isExtensionMutation(action: string) {
  return !["get_mcp", "read_skill", "export_skill", "pick_project", "pick_skill", "test_mcp", "validate_skill"].includes(action);
}

export function executeExtensionAction<T>(
  request: ExtensionTransport,
  scope: Scope,
  revision: string | undefined,
  action: Record<string, unknown>,
): Promise<T> {
  const name = String(action.action);
  const mutation = isExtensionMutation(name);
  if (mutation && pendingMutations.has(request)) {
    return Promise.reject(new Error("上次操作仍在执行，请刷新确认后再提交修改。"));
  }
  const timeout = name === "test_mcp" ? 35000
    : ["save_mcp", "set_mcp_enabled", "set_mcps_enabled", "remove_mcp"].includes(name) ? 45000
      : name.startsWith("pick_") ? 120000 : mutation ? 30000 : 15000;
  const operation = request<T>({ scope, revision, ...action });
  if (mutation) {
    invalidateInventory(request);
    pendingMutations.set(request, operation);
    const release = () => {
      if (pendingMutations.get(request) === operation) pendingMutations.delete(request);
      invalidateInventory(request);
    };
    void operation.then(release, release);
  }
  return withTimeout(operation, mutation, timeout);
}

// 缓存删除独立于普通库存；关闭窗口也不能绕过未完成写入的检查。
const skillCacheRequests = new WeakMap<ExtensionTransport, ReturnType<typeof createSkillCacheRequests>>();
export function getSkillCacheRequests(request: ExtensionTransport) {
  let session = skillCacheRequests.get(request);
  if (!session) {
    session = createSkillCacheRequests(request);
    skillCacheRequests.set(request, session);
  }
  return session;
}
export function createSkillCacheRequests(request: ExtensionTransport, timeout = 15000) {
  let pending: Promise<unknown> | undefined;
  let blocked = true;
  let generation = 0;
  return {
    get blocked() { return blocked; },
    waitForPending: () => pending ? withTimeout(pending.catch(() => undefined), false, timeout) : undefined,
    async list() {
      const current = ++generation;
      blocked = true;
      const value = await withTimeout((async () => {
        // 超时并不会中止后端请求，必须确认它结束后再读取。
        if (pending) await pending.catch(() => undefined);
        return request<SkillCacheInventory>({ action: "list_skill_cache" });
      })(), false, timeout);
      // 关闭后重开可能留下旧请求，旧结果不能解除新操作的限制。
      if (current === generation && !pending) blocked = false;
      return value;
    },
    read(id: string) {
      return withTimeout(request<{ id: string; content: string; revision: string; readOnly: true }>({ action: "read_skill_cache", id }), false, timeout);
    },
    async remove(id: string, revision: string) {
      if (blocked || pending) throw new Error("请先刷新缓存列表，确认上次操作结果后再删除。");
      const current = ++generation;
      blocked = true;
      const operation = request<{ cache: SkillCacheInventory; message: string }>({ action: "remove_skill_cache", id, revision, confirmed: true });
      pending = operation;
      void operation.then(() => { if (pending === operation) pending = undefined; }, () => { if (pending === operation) pending = undefined; });
      const result = await withTimeout(operation, true, timeout);
      if (current === generation) blocked = false;
      return result;
    },
  };
}
const caches = new WeakMap<
  ExtensionTransport,
  Map<
    string,
    { expires: number; value?: Inventory; pending?: Promise<Inventory> }
  >
>();
function scopeKey(scope: Scope) {
  return JSON.stringify(scope);
}
export function withTimeout<T>(
  promise: Promise<T>,
  mutation = false,
  milliseconds = 15000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            mutation
              ? "操作等待超时，后台可能仍在执行，结果尚不确定。请刷新确认后再操作，避免重复提交。"
              : "读取超时，请检查服务连接后重试。",
          ),
        ),
      milliseconds,
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
export function invalidateInventory(
  request: ExtensionTransport,
  scope?: Scope,
) {
  if (scope) caches.get(request)?.delete(scopeKey(scope));
  else caches.get(request)?.clear();
}
export function readInventory(
  request: ExtensionTransport,
  scope: Scope,
  force = false,
): Promise<Inventory> {
  let cache = caches.get(request);
  if (!cache) {
    cache = new Map();
    caches.set(request, cache);
  }
  const key = scopeKey(scope),
    previous = cache.get(key);
  if (!force && previous?.pending) return previous.pending;
  if (!force && previous?.value && previous.expires > Date.now())
    return Promise.resolve(previous.value);
  const record: {
    expires: number;
    value?: Inventory;
    pending?: Promise<Inventory>;
  } = { expires: 0 };
  record.pending = withTimeout(
    (async () => {
      // 前端超时不会取消写入；刷新必须等待实际操作结束，才能确认当前版本。
      const pending = pendingMutations.get(request);
      if (pending) await pending.catch(() => undefined);
      return request<Inventory>({ action: "list", scope });
    })(),
  ).then(
    (value) => {
      if (cache.get(key) === record) {
        record.value = value;
        record.expires = Date.now() + 3000;
        record.pending = undefined;
      }
      return value;
    },
    (error) => {
      if (cache.get(key) === record) cache.delete(key);
      throw error;
    },
  );
  cache.set(key, record);
  return record.pending;
}
