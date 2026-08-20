const NATIVE_HOST = "com.jairad26.scua";
const DEBUGGER_VERSION = "1.3";

let nativePort;
let reconnectTimer;
const workspaceMutations = new Map();

async function mutateWorkspace(params, operation) {
  const workspaceId = requireWorkspaceId(params);
  const prior = workspaceMutations.get(workspaceId) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(operation);
  workspaceMutations.set(workspaceId, current);
  try {
    return await current;
  } finally {
    if (workspaceMutations.get(workspaceId) === current) workspaceMutations.delete(workspaceId);
  }
}

async function allWorkspaces() {
  const stored = await chrome.storage.session.get("workspaces");
  return stored.workspaces && typeof stored.workspaces === "object" ? stored.workspaces : {};
}

async function saveWorkspaces(workspaces) {
  await chrome.storage.session.set({ workspaces });
}

function workspaceRecord(workspaces, workspaceId, workspaceName) {
  const existing = workspaces[workspaceId] ?? {};
  const record = {
    groupId: Number.isInteger(existing.groupId) ? existing.groupId : undefined,
    windowId: Number.isInteger(existing.windowId) ? existing.windowId : undefined,
    name: typeof workspaceName === "string" && workspaceName.trim() ? workspaceName.trim().slice(0, 80) : (existing.name || "SCUA"),
    ownedTabIds: new Set(Array.isArray(existing.ownedTabIds) ? existing.ownedTabIds.filter(Number.isInteger) : []),
  };
  workspaces[workspaceId] = record;
  return record;
}

function serializableWorkspaces(workspaces) {
  return Object.fromEntries(Object.entries(workspaces).map(([id, workspace]) => [id, {
    groupId: workspace.groupId,
    windowId: workspace.windowId,
    name: workspace.name,
    ownedTabIds: Array.isArray(workspace.ownedTabIds) ? workspace.ownedTabIds : [...workspace.ownedTabIds],
  }]));
}

async function saveRuntimeWorkspaces(workspaces) {
  await saveWorkspaces(serializableWorkspaces(workspaces));
}

async function existingWorkspace(workspace) {
  if (!Number.isInteger(workspace.groupId)) return undefined;
  try {
    const group = await chrome.tabGroups.get(workspace.groupId);
    if (group.title !== workspace.name) return undefined;
    workspace.windowId = group.windowId;
    return group;
  } catch {
    workspace.groupId = undefined;
    workspace.windowId = undefined;
    return undefined;
  }
}

async function targetWindow() {
  try {
    const focused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (Number.isInteger(focused?.id)) return { windowId: focused.id, reusedWindow: true };
  } catch {}
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const existing = windows.find((window) => Number.isInteger(window.id));
  if (existing) return { windowId: existing.id, reusedWindow: true };
  const created = await chrome.windows.create({ focused: false, url: "about:blank" });
  if (!Number.isInteger(created.id)) throw new Error("Chrome did not create a normal workspace window.");
  return { windowId: created.id, reusedWindow: false, createdTabId: created.tabs?.[0]?.id };
}

async function attach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  } catch (error) {
    if (!String(error?.message ?? error).includes("Another debugger is already attached")) throw error;
  }
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
}

async function waitForTabReady(tabId, timeoutMs = 15_000) {
  const ready = (tab) => tab?.status === "complete" && typeof tab.url === "string" && tab.url.length > 0;
  const current = await chrome.tabs.get(tabId);
  if (ready(current)) return current;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error);
      else resolve(tab);
    };
    const onUpdated = async (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || (changeInfo.status !== "complete" && !changeInfo.url)) return;
      const latest = tab?.status === "complete" ? tab : await chrome.tabs.get(tabId).catch(() => undefined);
      if (ready(latest)) finish(undefined, latest);
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) finish(new Error(`SCUA tab ${tabId} closed before it became ready.`));
    };
    const timer = setTimeout(() => finish(new Error(`SCUA tab ${tabId} did not finish loading within ${timeoutMs}ms.`)), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((latest) => { if (ready(latest)) finish(undefined, latest); }).catch((error) => finish(error));
  });
}

function requireWorkspaceId(params) {
  const workspaceId = typeof params?.workspaceId === "string" ? params.workspaceId.trim() : "";
  if (!workspaceId || workspaceId.length > 160) throw new Error("A bounded SCUA workspaceId is required.");
  return workspaceId;
}

function workspaceColor(workspaceId) {
  const colors = ["blue", "cyan", "green", "yellow", "orange", "pink", "purple"];
  let hash = 0;
  for (const character of workspaceId) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

async function allocateWorkspaceTab(params = {}) {
  const workspaceId = requireWorkspaceId(params);
  const url = typeof params.url === "string" && params.url ? params.url : "about:blank";
  const workspaces = await allWorkspaces();
  const workspace = workspaceRecord(workspaces, workspaceId, params.workspaceName);
  const group = await existingWorkspace(workspace);
  let reusedWindow = true;
  let tab;

  if (group) {
    tab = await chrome.tabs.create({ windowId: group.windowId, url, active: false });
    await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] });
  } else {
    const selected = await targetWindow();
    reusedWindow = selected.reusedWindow;
    tab = Number.isInteger(selected.createdTabId)
      ? await chrome.tabs.update(selected.createdTabId, { url, active: false })
      : await chrome.tabs.create({ windowId: selected.windowId, url, active: false });
    workspace.groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    workspace.windowId = selected.windowId;
    await chrome.tabGroups.update(workspace.groupId, { title: workspace.name, color: workspaceColor(workspaceId), collapsed: false });
  }

  if (!Number.isInteger(tab?.id)) throw new Error("Chrome did not return the new SCUA tab ID.");
  workspace.ownedTabIds.add(tab.id);
  await saveRuntimeWorkspaces(workspaces);
  return {
    tabId: tab.id,
    targetId: `scua-extension-tab:${tab.id}`,
    groupId: workspace.groupId,
    windowId: workspace.windowId,
    workspaceId,
    workspaceName: workspace.name,
    reusedWindow,
    active: Boolean(tab.active),
    title: tab.title ?? "",
    url: tab.url ?? url,
  };
}

async function finishWorkspaceTab(tab) {
  const current = await waitForTabReady(tab.tabId);
  await attach(tab.tabId);
  return {
    ...tab,
    active: Boolean(current.active),
    title: current.title ?? "",
    url: current.url ?? tab.url,
  };
}

async function ownedTabs(params) {
  const workspaceId = requireWorkspaceId(params);
  const workspaces = await allWorkspaces();
  const workspace = workspaceRecord(workspaces, workspaceId, params?.workspaceName);
  await existingWorkspace(workspace);
  const tabs = [];
  for (const tabId of [...workspace.ownedTabIds]) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.groupId !== workspace.groupId) {
        workspace.ownedTabIds.delete(tabId);
        continue;
      }
      tabs.push({ tabId, targetId: `scua-extension-tab:${tabId}`, groupId: tab.groupId, windowId: tab.windowId, workspaceId, workspaceName: workspace.name, active: Boolean(tab.active), title: tab.title ?? "", url: tab.url ?? "" });
    } catch {
      workspace.ownedTabIds.delete(tabId);
    }
  }
  await saveRuntimeWorkspaces(workspaces);
  return tabs;
}

async function requireOwnedTab(params) {
  const workspaceId = requireWorkspaceId(params);
  const tabId = Number(params?.tabId);
  const workspaces = await allWorkspaces();
  const workspace = workspaceRecord(workspaces, workspaceId);
  if (!workspace.ownedTabIds.has(tabId)) throw new Error(`Tab ${tabId} is not owned by SCUA workspace '${workspaceId}'.`);
  const tab = await chrome.tabs.get(tabId);
  if (tab.groupId !== workspace.groupId) {
    workspace.ownedTabIds.delete(tabId);
    await saveRuntimeWorkspaces(workspaces);
    throw new Error(`Tab ${tabId} left its SCUA workspace group.`);
  }
  return { tab, tabId, workspaces, workspace };
}

async function execute(message) {
  switch (message.method) {
    case "bridge.ping": return { ready: true };
    case "workspace.ensureTab": {
      // Serialize only the group/storage allocation. Page loading and debugger
      // attachment can then proceed concurrently across independent tabs.
      const tab = await mutateWorkspace(message.params, () => allocateWorkspaceTab(message.params));
      return await finishWorkspaceTab(tab);
    }
    case "workspace.listTabs": return await ownedTabs(message.params);
    case "workspace.close": return await mutateWorkspace(message.params, async () => {
      const workspaceId = requireWorkspaceId(message.params);
      const workspaces = await allWorkspaces();
      const workspace = workspaceRecord(workspaces, workspaceId, message.params?.workspaceName);
      const tabIds = [];
      for (const tabId of workspace.ownedTabIds) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.groupId === workspace.groupId) tabIds.push(tabId);
        } catch {}
      }
      for (const tabId of tabIds) await chrome.debugger.detach({ tabId }).catch(() => undefined);
      if (tabIds.length) await chrome.tabs.remove(tabIds).catch(() => undefined);
      delete workspaces[workspaceId];
      await saveRuntimeWorkspaces(workspaces);
      return { closed: tabIds.length };
    });
    case "workspace.closeTab": return await mutateWorkspace(message.params, async () => {
      const owned = await requireOwnedTab(message.params);
      await chrome.debugger.detach({ tabId: owned.tabId }).catch(() => undefined);
      await chrome.tabs.remove(owned.tabId);
      owned.workspace.ownedTabIds.delete(owned.tabId);
      await saveRuntimeWorkspaces(owned.workspaces);
      return { closed: true };
    });
    case "cdp.command": {
      const owned = await requireOwnedTab(message.params);
      await attach(owned.tabId);
      return await chrome.debugger.sendCommand({ tabId: owned.tabId }, message.params.method, message.params.params ?? {});
    }
    default: throw new Error(`Unsupported SCUA Chrome method '${message.method}'.`);
  }
}

async function onNativeMessage(message) {
  if (!message || message.type !== "request" || typeof message.clientId !== "string" || typeof message.id !== "string") return;
  try {
    const result = await execute(message);
    nativePort?.postMessage({ type: "response", clientId: message.clientId, id: message.id, result });
  } catch (error) {
    nativePort?.postMessage({ type: "response", clientId: message.clientId, id: message.id, error: { message: String(error?.message ?? error) } });
  }
}

function connectNative() {
  clearTimeout(reconnectTimer);
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort.onMessage.addListener(onNativeMessage);
    nativePort.onDisconnect.addListener(() => { nativePort = undefined; reconnectTimer = setTimeout(connectNative, 1000); });
    nativePort.postMessage({ type: "hello", extensionVersion: chrome.runtime.getManifest().version });
  } catch {
    nativePort = undefined;
    reconnectTimer = setTimeout(connectNative, 1000);
  }
}

chrome.runtime.onInstalled.addListener(connectNative);
chrome.runtime.onStartup.addListener(connectNative);
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const snapshot = await allWorkspaces();
  const affected = Object.entries(snapshot)
    .filter(([, workspace]) => Array.isArray(workspace.ownedTabIds) && workspace.ownedTabIds.includes(tabId))
    .map(([workspaceId]) => workspaceId);
  await Promise.all(affected.map((workspaceId) => mutateWorkspace({ workspaceId }, async () => {
    const workspaces = await allWorkspaces();
    const workspace = workspaces[workspaceId];
    if (!workspace || !Array.isArray(workspace.ownedTabIds)) return;
    workspace.ownedTabIds = workspace.ownedTabIds.filter((id) => id !== tabId);
    await saveWorkspaces(workspaces);
  })));
});
connectNative();
