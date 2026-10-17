// Codex's private desktop interfaces live behind this adapter. Installing it
// does not mount controls, observe the DOM, or start background polling.
(() => {
  const version = 1;
  const previous = window.__codeyNativeRuntime;
  if (previous?.version === version && previous.isActive?.()) return;
  previous?.dispose?.();
  let disposed = false;

  const waitForNativeSessionOperation = (operation) => new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Codex 会话接口响应超时")), 5_000);
    Promise.resolve().then(() => {
      if (disposed) throw new Error("Codex 原生接口适配已重新加载");
      return operation();
    }).then(resolve, reject).finally(() => window.clearTimeout(timer));
  });

  const codexAppAssetUrls = () => {
    const performanceUrls = (
      typeof performance !== "undefined"
      && typeof performance.getEntriesByType === "function"
    )
      ? performance.getEntriesByType("resource").map((entry) => entry.name)
      : [];
    return [...new Set([
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map((link) => link.href),
      ...performanceUrls,
    ].filter((url) => (
      url
      && url.includes("/assets/")
      && url.split("?")[0].endsWith(".js")
    )))];
  };

  const codexAssetReferencesFromSource = (source, baseUrl) => {
    const references = [];
    const pattern = /["']((?:\.\/(?:assets\/)?|\/assets\/)(?:app-initial|app-server-manager-signals|app-shared)(?:-[^"'?#/]+)?\.js(?:\?[^"']*)?)["']/g;
    for (const match of String(source || "").matchAll(pattern)) {
      try {
        const resolved = new URL(match[1], baseUrl).href;
        if (!references.includes(resolved)) references.push(resolved);
      } catch {
        continue;
      }
    }
    return references;
  };

  // 模块引用在同一页面内保持不变；只缓存成功读取的结果，页面状态仍每次重新探测。
  const codexAssetReferenceCache = new Map();
  const discoverCodexAppAssetUrls = async () => {
    const loadedUrls = codexAppAssetUrls();
    const discoveredUrls = loadedUrls.filter((url) => (
      url.includes("app-server-manager-signals-")
      || url.includes("app-initial-")
      || url.includes("app-shared-")
    ));
    const fetchAsset = typeof window.fetch === "function"
      ? window.fetch.bind(window)
      : (typeof fetch === "function" ? fetch : null);
    if (!fetchAsset) return discoveredUrls;

    const scriptUrls = [...new Set([
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...loadedUrls,
    ])].filter((url) => (
      url
      && !url.includes("app-server-manager-signals-")
      && !url.includes("app-initial-")
      && !url.includes("app-shared-")
    )).slice(0, 6);
    for (const scriptUrl of scriptUrls) {
      try {
        let references = codexAssetReferenceCache.get(scriptUrl);
        if (!references) {
          const response = await fetchAsset(scriptUrl);
          if (!response?.ok || typeof response.text !== "function") continue;
          references = codexAssetReferencesFromSource(await response.text(), scriptUrl);
          codexAssetReferenceCache.set(scriptUrl, references);
        }
        for (const assetUrl of references) {
          if (!discoveredUrls.includes(assetUrl)) discoveredUrls.push(assetUrl);
        }
      } catch {
        continue;
      }
    }
    return discoveredUrls;
  };

  const signalDispatcherFromModule = (module, namedSignalAsset) => {
    const preferred = namedSignalAsset ? [module?.rn, module?.O] : [module?.O, module?.rn];
    const candidates = [...preferred, ...Object.values(module || {})].filter((
      candidate,
      index,
      values,
    ) => typeof candidate === "function" && values.indexOf(candidate) === index);
    const matches = candidates.filter((candidate) => {
      let source = "";
      try {
        source = Function.prototype.toString.call(candidate);
      } catch {
        return false;
      }
      return (
        candidate.length >= 2
        && candidate.length <= 3
        && !/\bthis\.[\w$]+\.sendRequest\(/.test(source)
        && /(?:\breturn\b|=>)[^{};]{0,240}\b[A-Za-z_$][\w$]*\.sendRequest\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*/.test(source)
      );
    });
    const preferredMatches = matches.filter((candidate) => preferred.includes(candidate));
    if (namedSignalAsset && preferredMatches.length === 1) return preferredMatches[0];
    return matches.length === 1 ? matches[0] : null;
  };

  const appServerManagerResolverFromModule = (module) => {
    const candidates = [...new Set(Object.values(module || {}).filter((candidate) => (
      typeof candidate === "function"
    )))];
    const matches = candidates.filter((candidate) => {
      let source = "";
      try {
        source = Function.prototype.toString.call(candidate);
      } catch {
        return false;
      }
      return (
        candidate.length >= 2
        && candidate.length <= 3
        && /AppServerManager RPC is (?:not connected|unavailable for hostId:)/.test(source)
        && /\.get\(/.test(source)
        && /\.forHost\(/.test(source)
      );
    });
    return matches.length === 1 ? matches[0] : null;
  };

  const reactFiberFromElement = (element) => {
    if (!(element instanceof HTMLElement)) return null;
    const key = Object.keys(element).find((candidate) => (
      candidate.startsWith("__reactFiber$")
      || candidate.startsWith("__reactInternalInstance$")
    ));
    return key ? element[key] : null;
  };

  const collectAppServerScopeCandidates = (root, candidates, seen) => {
    const queue = [{ depth: 0, value: root }];
    let cursor = 0;
    let inspected = 0;
    while (cursor < queue.length && inspected < 600 && candidates.length < 48) {
      const { depth, value } = queue[cursor];
      cursor += 1;
      if (
        !value
        || (typeof value !== "object" && typeof value !== "function")
        || seen.has(value)
      ) continue;
      seen.add(value);
      inspected += 1;
      let descriptors;
      try {
        descriptors = Object.getOwnPropertyDescriptors(value);
      } catch {
        continue;
      }
      const hasFunction = (name) => {
        if (typeof descriptors[name]?.value === "function") return true;
        try {
          return typeof value[name] === "function";
        } catch {
          return false;
        }
      };
      if (
        hasFunction("get")
        && hasFunction("set")
        && hasFunction("watch")
        && hasFunction("when")
        && Object.prototype.hasOwnProperty.call(descriptors, "query")
      ) {
        candidates.push(value);
      }
      if (depth >= 6) continue;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (
          !Object.prototype.hasOwnProperty.call(descriptor, "value")
          || ["return", "child", "sibling", "alternate", "stateNode", "_owner"].includes(key)
        ) continue;
        const nested = descriptor.value;
        if (nested && (typeof nested === "object" || typeof nested === "function")) {
          queue.push({ depth: depth + 1, value: nested });
        }
      }
    }
  };

  const appServerManagerFromReact = (resolver) => {
    const elements = [...new Set([
      ...Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-row]") || []),
      ...Array.from(document.querySelectorAll("[data-turn-key]") || []),
      document.querySelector("[data-app-action-sidebar-section]"),
      document.querySelector("[data-app-action-sidebar-project-row]"),
      document.querySelector("#root"),
      document.body,
    ].filter((element) => element instanceof HTMLElement))].slice(0, 32);
    const seenScopes = new WeakSet();
    const seenFibers = new WeakSet();
    for (const element of elements) {
      let fiber = reactFiberFromElement(element);
      for (let depth = 0; fiber && depth < 24; depth += 1, fiber = fiber.return) {
        if (seenFibers.has(fiber)) continue;
        seenFibers.add(fiber);
        const candidates = [];
        const seenValues = new WeakSet();
        collectAppServerScopeCandidates(fiber.memoizedState, candidates, seenValues);
        collectAppServerScopeCandidates(fiber.memoizedProps, candidates, seenValues);
        collectAppServerScopeCandidates(fiber.dependencies, candidates, seenValues);
        collectAppServerScopeCandidates(fiber.updateQueue, candidates, seenValues);
        for (const scope of candidates) {
          if (seenScopes.has(scope)) continue;
          seenScopes.add(scope);
          try {
            const manager = resolver(scope, "local");
            if (
              manager
              && ["sendRequest", "refreshRecentConversations", "codeyReconcileCompletedConversation"]
                .some((method) => typeof manager[method] === "function")
            ) return manager;
          } catch {
            continue;
          }
        }
      }
    }
    return null;
  };

  const legacySessionController = (dispatcher) => ({
    kind: "signals",
    dispatcher,
    refreshRecentConversations: () => dispatcher("refresh-recent-conversations-for-host", {
      hostId: "local",
    }),
  });

  const declaredMethod = (object, name) => {
    for (let depth = 0; object && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor) return typeof descriptor.value === "function" ? descriptor.value : null;
      object = Object.getPrototypeOf(object);
    }
    return null;
  };

  const appServerManagerRegistryResolverFromModule = (module) => {
    const lookups = [...new Set(Object.values(module || {}))].flatMap((candidate) => {
      if (typeof candidate !== "function") return [];
      const prototype = Object.getOwnPropertyDescriptor(candidate, "prototype")?.value;
      if (!prototype || !declaredMethod(prototype, "getAll")) return [];
      const lookup = declaredMethod(prototype, "getForHostId");
      if (!lookup || !Function.prototype.toString.call(lookup).includes(".scope.get(")) return [];
      return [lookup];
    });
    return lookups.length === 1
      ? (scope, hostId) => lookups[0].call({ scope }, hostId) : null;
  };

  const nativeAppServerManagerFromScope = (scope, hostId) => {
    if (hostId !== "local" || typeof scope?.get !== "function") return null;
    // Newer Codex no longer exports the registry class. Its local manager is
    // still held in a signal family; read only cached members, without mounting
    // unrelated state or treating an RPC proxy as a concrete request client.
    const nodes = new Set([scope.node, ...scope.chain?.values?.() || []]);
    const matches = new Set();
    for (const node of nodes) {
      for (const [family, bindings] of node?.familyBindings?.entries?.() || []) {
        if (family?.kind !== "signal-family" || !bindings?.has?.(hostId)) continue;
        try {
          const manager = scope.get(family, hostId);
          const client = Object.getOwnPropertyDescriptor(manager ?? {}, "requestClient")?.value;
          const getHostId = declaredMethod(manager, "getHostId");
          if (
            Object.getOwnPropertyDescriptor(client ?? {}, "hostId")?.value === hostId
            && ["enqueueRequest", "createRequest", "onResult"].every((name) => declaredMethod(client, name))
            && declaredMethod(manager, "sendRequest")
            && getHostId?.call(manager) === hostId
          ) matches.add(manager);
        } catch {
          continue;
        }
      }
    }
    return matches.size === 1 ? [...matches][0] : null;
  };

  const messageDeletionMethods = {
    async prepare(conversationId) {
      const conversation = this.getConversation(conversationId);
      const history = conversation?.turnHistory;
      if (
        !Array.isArray(conversation?.turns)
        || (history != null && (history.kind !== "canonical"
          || !Array.isArray(history.history?.islands)
          || !history.history.islands.every((island) => Array.isArray(island.entries))
          || !Number.isInteger(history.history.generation)
          || !history.history.entitiesByKey
          || typeof history.history.entitiesByKey !== "object"))
      ) throw new Error("当前会话不支持局部删除");
      const turns = [...conversation.turns, ...Object.values(history?.history?.entitiesByKey || {})];
      if (
        conversation.threadRuntimeStatus?.type === "active"
        || conversation.requests?.length
        || turns.some((turn) => turn?.status === "inProgress")
      ) throw new Error("当前任务仍在运行，请等待任务结束后再删除");
      if (this.getStreamRole(conversationId)?.role === "follower") {
        throw new Error("请在拥有当前会话的窗口中删除消息");
      }
      await this.sendRequest("thread/unsubscribe", { threadId: conversationId });
    },
    finish(conversationId, messageIds) {
      const selected = new Set(messageIds);
      this.updateConversationState(conversationId, (conversation) => {
        if (selected.size) {
          const deletedTurns = new Set();
          const history = conversation.turnHistory?.kind === "canonical"
            ? conversation.turnHistory.history : null;
          if (history) {
            history.generation += 1;
            const deletedKeys = new Set(Object.keys(history.entitiesByKey).filter((key) => (
              selected.has(history.entitiesByKey[key]?.turnId)
              || selected.has(key)
              || selected.has(`history-content:${key}`)
            )));
            for (const island of history.islands) {
              island.entries = island.entries.filter((entry) => !deletedKeys.has(entry.value));
            }
            for (const key of deletedKeys) {
              deletedTurns.add(history.entitiesByKey[key]);
              delete history.entitiesByKey[key];
            }
          }
          conversation.turns = conversation.turns.filter((turn) => (
            !selected.has(turn.turnId) && !deletedTurns.has(turn)
          ));
        }
        conversation.resumeState = "needs_resume";
      });
      this.inactiveThreadUnsubscriber.clearConversationStreamOwnership(conversationId);
    },
  };
  const isLocalMessageDeletionManager = (manager) => {
    if (!["getHostId", "getConversation", "getStreamRole", "sendRequest", "updateConversationState"]
      .every((name) => declaredMethod(manager, name))) return false;
    const unsubscriber = Object.getOwnPropertyDescriptor(manager, "inactiveThreadUnsubscriber")?.value;
    return Boolean(declaredMethod(unsubscriber, "clearConversationStreamOwnership"))
      && manager.getHostId() === "local";
  };

  const managerSessionController = (manager) => {
    const canDeleteMessages = isLocalMessageDeletionManager(manager);
    return {
      kind: "manager",
      manager,
      prepareMessageDeletion: canDeleteMessages ? messageDeletionMethods.prepare.bind(manager) : null,
      finishMessageDeletion: canDeleteMessages ? messageDeletionMethods.finish.bind(manager) : null,
      refreshRecentConversations: typeof manager.refreshRecentConversations === "function"
        ? () => manager.refreshRecentConversations() : null,
      reconcileCompletedConversation: typeof manager.codeyReconcileCompletedConversation === "function"
        ? (payload) => manager.codeyReconcileCompletedConversation(payload)
        : null,
    };
  };

  const sessionControllerLooksUsable = (controller, feature = "session") => {
    if (!controller) return false;
    if (feature === "modelRouting") {
      const client = controller.manager?.requestClient;
      return client?.hostId === "local"
        && ["enqueueRequest", "createRequest", "onResult"].every((method) => declaredMethod(client, method));
    }
    if (feature === "usage" || feature === "mcpReload") return typeof controller.manager?.sendRequest === "function";
    if (feature === "remote") return typeof controller.manager?.resumeConversation === "function";
    if (feature === "reconcile") return sessionControllerCanReconcileCompletedConversation(controller);
    const methods = feature === "deleteMessages"
      ? ["prepareMessageDeletion", "finishMessageDeletion"]
      : feature === "refresh" ? ["refreshRecentConversations"] : [];
    return methods.length ? methods.every((method) => typeof controller[method] === "function")
      : controller.kind === "manager" || controller.kind === "signals";
  };

  const capabilityProbes = new Map();
  const capabilityLabels = { usage: "官方额度读取", mcpReload: "MCP 配置刷新", reconcile: "完成状态同步", deleteMessages: "消息删除", modelRouting: "模型请求校验", refresh: "会话列表刷新", session: "会话管理" };
  const capabilityMessage = (feature) => `当前 Codex 暂不支持${capabilityLabels[feature] || "此功能"}，请稍后重试`;
  const pageCapabilities = Object.create(null);
  const publishCapability = (feature, available) => {
    if (disposed) return;
    pageCapabilities[feature] = {
      status: available ? "available" : "unavailable",
      message: available ? "" : capabilityMessage(feature),
    };
  };
  const unavailableCapability = (feature) => {
    publishCapability(feature, false);
    const error = new Error(capabilityMessage(feature));
    error.code = "codey_capability_unavailable";
    return error;
  };

  const sessionControllerCanReconcileCompletedConversation = (controller) => (
    controller?.kind === "manager"
    && typeof controller.reconcileCompletedConversation === "function"
  );

  const discoverCodexSessionController = async (feature) => {
    if (disposed) throw unavailableCapability(feature);
    const requireCompletionReconcile = feature === "reconcile";
    // Rebuild wrappers so methods added by a late renderer patch become usable.
    if (window.__codeyCodexSessionController?.manager) {
      window.__codeyCodexSessionController = managerSessionController(window.__codeyCodexSessionController.manager);
    }
    if (sessionControllerLooksUsable(window.__codeyCodexSessionController, feature)) {
      return window.__codeyCodexSessionController;
    }
    const requiresNativeManager = feature === "deleteMessages" || feature === "modelRouting";
    if (requiresNativeManager) {
      const manager = appServerManagerFromReact(nativeAppServerManagerFromScope);
      const controller = manager ? managerSessionController(manager) : null;
      if (sessionControllerLooksUsable(controller, feature)) {
        window.__codeyCodexSessionController = controller;
        return controller;
      }
    }
    let fallbackDispatcher = typeof window.__codeyCodexSignalDispatcher === "function"
      ? window.__codeyCodexSignalDispatcher
      : null;
    // 新版 Codex 把 AppServerManager 解析器放在 app-shared 里，app-initial
    // 只剩单参辅助函数；保留原有优先级，只在 app-initial 无法解析时下沉。
    const managerAssetPriority = (url) => (
      url.includes("app-initial-")
        ? 3
        : url.includes("app-shared-")
          ? 2
          : Number(url.includes("app-server-manager-signals-"))
    );
    const urls = (await discoverCodexAppAssetUrls())
      .sort((left, right) => managerAssetPriority(right) - managerAssetPriority(left));
    if (disposed) throw unavailableCapability(feature);
    for (const url of urls) {
      const namedSignalAsset = url.includes("app-server-manager-signals-");
      try {
        const module = typeof window.__codeyImportCodexAsset === "function"
          ? await window.__codeyImportCodexAsset(url)
          : await import(url);
        // 旧安装的迟到探测不能替换新安装已确认的接口。
        if (disposed) throw unavailableCapability(feature);
        const resolvers = [
          requiresNativeManager ? appServerManagerRegistryResolverFromModule(module) : null,
          appServerManagerResolverFromModule(module),
        ].filter(Boolean);
        for (const resolver of resolvers) {
          const manager = appServerManagerFromReact(resolver);
          if (!manager) continue;
          const controller = managerSessionController(manager);
          if (sessionControllerLooksUsable(controller, feature)) {
            window.__codeyCodexSessionController = controller;
            return controller;
          }
          window.__codeyCodexSessionController ||= controller;
        }
        fallbackDispatcher ||= signalDispatcherFromModule(module, namedSignalAsset);
      } catch (error) {
        if (disposed) throw error;
        continue;
      }
    }
    if (fallbackDispatcher && !requireCompletionReconcile && feature !== "usage" && feature !== "mcpReload" && feature !== "deleteMessages" && feature !== "remote" && feature !== "modelRouting") {
      window.__codeyCodexSignalDispatcher = fallbackDispatcher;
      const controller = legacySessionController(fallbackDispatcher);
      window.__codeyCodexSessionController = controller;
      return controller;
    }
    throw unavailableCapability(feature);
  };
  const loadCodexSessionController = async ({ requireCompletionReconcile = false, feature = "session" } = {}) => {
    if (requireCompletionReconcile) feature = "reconcile";
    if (disposed) throw unavailableCapability(feature);
    const cached = window.__codeyCodexSessionController;
    const current = cached?.manager ? managerSessionController(cached.manager) : cached;
    if (sessionControllerLooksUsable(current, feature)) {
      window.__codeyCodexSessionController = current;
      capabilityProbes.delete(feature);
      publishCapability(feature, true);
      return current;
    }
    const state = capabilityProbes.get(feature) || { failures: 0, retryAt: 0, pending: null };
    capabilityProbes.set(feature, state);
    if (state.pending) return state.pending;
    // modelRouting 的调用方只有请求入口校验，重试节奏由宿主注入流程控制；
    // 这里套用指数退避会让一次早期探测失败冻结后续所有注入尝试。
    if (feature !== "modelRouting" && Date.now() < state.retryAt) throw unavailableCapability(feature);
    const discover = () => discoverCodexSessionController(feature);
    // MCP 刷新由宿主 CDP 预算约束；5 秒发现上限会让慢机或尚未 hydrate 的
    // 页面在导入/启停后误报失败，只能重启 Codex。
    state.pending = (feature === "mcpReload"
      ? Promise.resolve().then(discover)
      : waitForNativeSessionOperation(discover)).then((controller) => {
      if (disposed) throw unavailableCapability(feature);
      state.failures = 0;
      state.retryAt = 0;
      publishCapability(feature, true);
      return controller;
    }, (error) => {
      state.failures += 1;
      state.retryAt = Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(state.failures - 1, 5));
      const capabilityError = unavailableCapability(feature);
      // 探测超时、资源导入失败等真实原因要带进抛出的错误里：capability 状态
      // 对用户保持通用文案，但错误日志需要能区分结构漂移和探测失败。
      const reason = String(error?.message || error || "");
      if (reason && reason !== capabilityError.message) {
        capabilityError.message = `${capabilityError.message}（${reason}）`;
      }
      throw capabilityError;
    }).finally(() => { state.pending = null; });
    return state.pending;
  };
  const loadRequestClient = async () => {
    const controller = await loadCodexSessionController({ feature: "modelRouting" });
    if (disposed) throw unavailableCapability("modelRouting");
    return controller.manager.requestClient;
  };

  const loadCodexSignalDispatcher = async () => {
    const controller = await loadCodexSessionController();
    if (disposed) throw unavailableCapability("session");
    if (controller.kind === "signals" && typeof controller.dispatcher === "function") {
      return controller.dispatcher;
    }
    throw new Error("当前 Codex 使用 AppServerManager 会话接口");
  };

  const getCodexSessionController = (feature) => loadCodexSessionController({ feature });

  const readAccountRateLimits = async () => {
    let controller;
    try {
      controller = await getCodexSessionController("usage");
      if (disposed) throw unavailableCapability("usage");
    } catch (error) {
      if (error?.code !== "codey_capability_unavailable") throw error;
      return { status: "unavailable", code: error.code, message: error.message };
    }
    // Managed ChatGPT authentication, token refresh, credential-store access,
    // and request serialization stay inside Codex's own AppServerManager.
    return controller.manager.sendRequest("account/rateLimits/read");
  };

  const appServerRequestClient = () => {
    const clients = window.__codeyAppServerRequestClients;
    if (!clients || typeof clients.get !== "function") return null;
    const local = clients.get("local");
    if (local && typeof local.sendRequest === "function") return local;
    if (typeof clients.values !== "function") return null;
    const all = [...clients.values()].filter((client) => typeof client?.sendRequest === "function");
    return all.length === 1 ? all[0] : null;
  };

  const reloadMcpServers = async () => {
    if (disposed) throw unavailableCapability("mcpReload");
    capabilityProbes.delete("mcpReload");
    const sendReload = async (target) => {
      // Codex 协议要求 params 为对象；原生实现会把配置应用到已加载会话的下一轮。
      await target.sendRequest("config/mcpServer/reload", {});
      publishCapability("mcpReload", true);
      return { ok: true };
    };
    const client = appServerRequestClient();
    if (client) {
      try {
        return await sendReload(client);
      } catch (error) {
        if (/unknown method/i.test(String(error?.message || error))) throw error;
      }
    }
    const controller = await loadCodexSessionController({ feature: "mcpReload" });
    if (disposed) throw unavailableCapability("mcpReload");
    try {
      return await sendReload(controller.manager);
    } catch (error) {
      if (!disposed) window.__codeyCodexSessionController = null;
      throw error;
    }
  };

  const remoteCreationInputsFactoryFromModule = (module) => {
    const matches = [...new Set(Object.values(module || {}))].filter((value) => {
      if (typeof value !== "function" || value.length !== 2) return false;
      const source = Function.prototype.toString.call(value);
      return /\bscope\s*:/.test(source) && /\bhostId\s*:/.test(source)
        && /\brequestClient\s*:\s*[\w$]+\.get\(/.test(source)
        && /\bdynamicTools\s*:\s*new\b/.test(source);
    });
    return matches.length === 1 ? matches[0] : null;
  };

  const remoteModelSettingsOverride = (scope, cwd) => {
    if (typeof scope?.get !== "function") return null;
    // When startup overrides win config/batchWrite, the native composer keeps
    // its last selection in a signal family keyed by host and working directory.
    // Read only already-instantiated entries; do not mount unrelated signals.
    const nodes = new Set([scope.node, ...scope.chain?.values?.() || []]);
    for (const directory of new Set([cwd ?? null, null])) {
      const matches = new Map();
      for (const node of nodes) {
        for (const [family, bindings] of node?.familyBindings?.entries?.() || []) {
          if (family?.kind !== "signal-family" || !bindings?.has?.(`local:${directory ?? ""}`)) continue;
          try {
            const value = scope.get(family, { hostId: "local", cwd: directory });
            if (!value || typeof value.model !== "string" || !value.model.trim()
              || typeof value.reasoningEffort !== "string"
              || !(value.profile === null || typeof value.profile === "string")
              || Object.keys(value).some(key => !["model", "reasoningEffort", "profile"].includes(key))) continue;
            const settings = { model: value.model, effort: value.reasoningEffort };
            matches.set(JSON.stringify(settings), settings);
          } catch { continue; }
        }
      }
      if (matches.size > 1) throw new Error("桌面默认模型设置不明确，请在电脑端重新选择模型");
      if (matches.size === 1) return [...matches.values()][0];
    }
    return null;
  };

  const remoteCreationContext = async () => {
    const factories = new Set();
    const resolvers = new Set();
    const registryResolvers = new Set();
    const serviceTierReaders = new Set();
    for (const url of await discoverCodexAppAssetUrls()) {
      if (!url.includes("app-initial-") && !url.includes("app-shared-")) continue;
      try {
        const module = typeof window.__codeyImportCodexAsset === "function"
          ? await window.__codeyImportCodexAsset(url) : await import(url);
        const factory = remoteCreationInputsFactoryFromModule(module);
        const resolver = appServerManagerResolverFromModule(module);
        const registryResolver = appServerManagerRegistryResolverFromModule(module);
        if (factory) factories.add(factory);
        if (resolver) resolvers.add(resolver);
        if (registryResolver) registryResolvers.add(registryResolver);
        for (const value of Object.values(module || {})) {
          if (typeof value !== "function") continue;
          const source = Function.prototype.toString.call(value);
          if (source.includes("Failed to read service tier for request") && source.includes("service_tier")) {
            serviceTierReaders.add(value);
          }
        }
      } catch {
        continue;
      }
    }
    // Newer Codex exports the creation reader from app-initial and the manager
    // resolver from app-shared. Resolve both against the same local scope.
    for (const resolver of [...resolvers, ...registryResolvers]) {
      for (const factory of factories) {
        let reader = null;
        const manager = appServerManagerFromReact((scope, hostId) => {
          const candidate = resolver(scope, hostId);
          if (typeof candidate?.startConversation !== "function") return null;
          const inputs = factory(scope, hostId);
          if (typeof inputs?.readCreationInputs !== "function") return null;
          reader = inputs;
          return candidate;
        });
        if (manager && reader) return { manager, reader, readServiceTier: serviceTierReaders.size === 1 ? [...serviceTierReaders][0] : null };
      }
    }
    throw new Error("当前 Codex 暂不支持远程新建会话，请更新 CodeyX 后重试");
  };

  // Keep creation and resumption inside the desktop's native manager. In
  // particular, its creation-input reader installs the same tools, project
  // instructions and permission defaults as the desktop composer.
  const remoteControl = async (args, expiresAt) => {
    const assertCurrent = () => {
      if (disposed || Date.now() >= expiresAt) throw new Error("远程操作已过期，请检查会话状态");
    };
    assertCurrent();
    if (args.action === "resume") {
      const controller = await getCodexSessionController("remote");
      const manager = controller.manager;
      if (typeof manager?.resumeConversation !== "function") {
        throw new Error("当前 Codex 暂不支持远程读取会话，请更新 CodeyX 后重试");
      }
      assertCurrent();
      // resumeConversation also discovers an owner in another window and
      // follows it. Never steal ownership with a second app-server process.
      const result = await manager.resumeConversation({
        conversationId: args.threadId, model: null, serviceTier: null,
        reasoningEffort: null, workspaceRoots: [], collaborationMode: null,
      });
      if (result?.status !== "ready") throw new Error("桌面尚未就绪，暂时无法读取此会话");
      return { status: "ok" };
    }
    if (args.action !== "create" && args.action !== "defaults") throw new Error("不支持的远程会话操作");
    const { manager, reader, readServiceTier } = await remoteCreationContext();
    assertCurrent();
    if (args.action === "defaults") {
      if (typeof manager.sendRequest !== "function") throw new Error("当前 Codex 暂不支持读取默认设置");
      const { config } = await manager.sendRequest("config/read", { includeLayers: false, cwd: args.cwd });
      assertCurrent();
      if (!config || typeof config !== "object") throw new Error("桌面默认设置格式不兼容");
      const override = remoteModelSettingsOverride(reader.params?.scope, args.cwd);
      const model = override?.model ?? config.model;
      const effort = override?.effort ?? config.model_reasoning_effort;
      const tier = readServiceTier && reader.params?.scope
        ? await readServiceTier(reader.params.scope, "local", model) : config.service_tier;
      assertCurrent();
      // Only expose composer settings: config/read may also contain credentials.
      return {
        ...(typeof model === "string" ? { model } : {}),
        ...(typeof effort === "string" ? { effort } : {}),
        serviceTier: tier === "priority" ? "priority" : "default",
      };
    }
    const result = await manager.startConversation(args.params, {
      readThreadCreationInputs: async (...values) => {
        assertCurrent();
        const inputs = await reader.readCreationInputs(...values);
        assertCurrent();
        return inputs;
      },
    });
    if (result?.status !== "created" || !result.conversationId) {
      throw new Error("新建结果尚未确认，请先检查会话列表，勿重复发送");
    }
    return {
      id: result.conversationId,
      firstTurn: result.firstTurn?.status || "outcome-unknown",
    };
  };

  // Preserve existing host/user-script entry points while their implementation
  // and lifetime belong exclusively to the adapter.
  const exports = {
    __codeyCodexAssetReferencesFromSource: codexAssetReferencesFromSource,
    __codeySignalDispatcherFromModule: signalDispatcherFromModule,
    __codeyAppServerManagerResolverFromModule: appServerManagerResolverFromModule,
    __codeyAppServerManagerFromReact: appServerManagerFromReact,
    __codeyAppServerManagerRegistryResolverFromModule: appServerManagerRegistryResolverFromModule,
    __codeyLoadCodexSessionController: loadCodexSessionController,
    __codeyLoadCodexRequestClient: loadRequestClient,
    __codeyLoadCodexSignalDispatcher: loadCodexSignalDispatcher,
    __codeyReadAccountRateLimits: readAccountRateLimits,
    __codeyReloadMcpServers: reloadMcpServers,
    __codeyRemoteControl: remoteControl,
    __codeyPageCapabilities: pageCapabilities,
  };
  const api = Object.freeze({
    version,
    isActive: () => !disposed,
    loadSessionController: loadCodexSessionController,
    waitForOperation: waitForNativeSessionOperation,
    dispose() {
      if (disposed) return;
      disposed = true;
      capabilityProbes.clear();
      codexAssetReferenceCache.clear();
      if (window.__codeyNativeRuntime !== api) return;
      for (const [name, value] of Object.entries(exports)) {
        if (window[name] === value) delete window[name];
      }
      delete window.__codeyCodexSessionController;
      delete window.__codeyCodexSignalDispatcher;
      delete window.__codeyNativeRuntime;
      // Native-operation timeout promises still settle after disposal. Their
      // late discovery results check disposed before publishing any state.
    },
  });
  Object.assign(window, exports);
  window.__codeyNativeRuntime = api;
})();
