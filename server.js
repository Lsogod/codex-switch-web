const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "4312", 10);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const APP_PACKAGE_PATH = path.join(ROOT, "package.json");
const BUNDLED_CODEX_SWITCH = path.join(ROOT, "bin", "codex-switch");
const LOCAL_CODEX_SWITCH = path.join(os.homedir(), ".local", "bin", "codex-switch");
const PROFILES_DIR = path.join(os.homedir(), ".codex-profiles");
const ACTIVE_CODEX_DIR = path.join(os.homedir(), ".codex");
const SHARED_SESSIONS_DIR = path.join(PROFILES_DIR, ".shared-sessions");
const SHARED_GLOBAL_STATE_PATH = path.join(PROFILES_DIR, ".shared-global-state.json");
const CODEX_APP_SUPPORT_DIR = path.join(os.homedir(), "Library", "Application Support", "Codex");
const CODEX_CACHE_RESET_ITEMS = [
  "Local Storage",
  "Session Storage",
  "Cache",
  "Code Cache"
];
const PROCESS_POLL_ATTEMPTS = 12;
const PROCESS_POLL_DELAY_MS = 500;
const PROFILE_POLL_ATTEMPTS = 12;
const PROFILE_POLL_DELAY_MS = 250;
const USAGE_CACHE_TTL_MS = 5 * 1000;
const USAGE_FETCH_TIMEOUT_MS = 3 * 1000;
const USAGE_FAILURE_NOTICE_AFTER_MS = 5 * 60 * 1000;
const AUTO_SWITCH_POLL_MS = 15 * 1000;
const AUTO_SWITCH_COOLDOWN_MS = 45 * 1000;
const LOGIN_STAGING_PREFIX = "login-staging-";
const LOCAL_SESSION_LIMIT = 30;
const RECENT_CONVERSATION_SEED_LIMIT = 100;
const SHARED_REPAIR_BACKUPS_DIR = path.join(PROFILES_DIR, ".repair-backups");
const SIDEBAR_WORKSPACE_FILTER_KEY = "sidebar-workspace-filter-v2";
const SIDEBAR_ORGANIZE_MODE_KEY = "sidebar-organize-mode-v1";
const THREAD_SORT_ATOM_KEY = "thread-sort-key";
const GLOBAL_STATE_FILE_NAME = ".codex-global-state.json";
const IGNORED_WORKSPACE_ROOTS = new Set([
  path.join(os.homedir(), "Documents", "Playground")
]);
const SHARED_SESSION_DIRS = ["sessions", "shell_snapshots"];
const SHARED_SESSION_FILES = [
  "session_index.jsonl",
  "state_5.sqlite",
  "state_5.sqlite-shm",
  "state_5.sqlite-wal",
  "logs_1.sqlite",
  "logs_1.sqlite-shm",
  "logs_1.sqlite-wal"
];
const SQLITE_SESSION_DATABASES = [
  { baseName: "state_5.sqlite", kind: "state" },
  { baseName: "logs_1.sqlite", kind: "logs" }
];
const SHARED_SESSION_ITEMS = [...SHARED_SESSION_DIRS, ...SHARED_SESSION_FILES];
const AUTO_SWITCH_STATE_FILE = path.join(PROFILES_DIR, ".auto-switch.json");
const UPDATE_CACHE_TTL_MS = 10 * 60 * 1000;
const APP_UPDATE_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const GITHUB_REPO = "Lsogod/codex-switch-web";
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const USAGE_SNAPSHOT_FILE = path.join(PROFILES_DIR, ".usage-last-success.json");
const usageCache = new Map();
let usageSnapshotStore = null;
const updateCache = {
  expiresAt: 0,
  value: null
};
const proxyEnvCache = {
  expiresAt: 0,
  value: null
};
const appUpdateRuntime = {
  inFlight: false,
  phase: "idle",
  message: null,
  error: null,
  startedAt: null,
  targetVersion: null,
  releaseUrl: null,
  downloadUrl: null,
  assetName: null,
  logPath: path.join(os.homedir(), "Library", "Logs", "Codex Switch Updater.log"),
  task: null
};
const autoSwitchRuntime = {
  enabled: false,
  inFlight: false,
  lastCheckAt: null,
  lastActionAt: null,
  lastAction: null,
  lastDecision: null,
  lastError: null
};
const APP_PACKAGE = (() => {
  try {
    return JSON.parse(fs.readFileSync(APP_PACKAGE_PATH, "utf8"));
  } catch {
    return {};
  }
})();
const APP_VERSION = typeof APP_PACKAGE.version === "string" ? APP_PACKAGE.version : "0.0.0";

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getCodexSwitchCommand() {
  const overridePath = process.env.CODEX_SWITCH_PATH;
  if (overridePath && isExecutableFile(overridePath)) {
    return overridePath;
  }

  if (isExecutableFile(BUNDLED_CODEX_SWITCH)) {
    return BUNDLED_CODEX_SWITCH;
  }

  if (isExecutableFile(LOCAL_CODEX_SWITCH)) {
    return LOCAL_CODEX_SWITCH;
  }

  return "codex-switch";
}

function getCodexSwitchInstallHint() {
  return "codex-switch is required. DMG builds should use the bundled copy; source runs can install bin/codex-switch to ~/.local/bin or add codex-switch to PATH.";
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, data, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(data);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function isValidProfileName(name) {
  return typeof name === "string" && /^[A-Za-z0-9._@+-]+$/.test(name);
}

function isInternalProfileName(name) {
  return typeof name === "string" && name.startsWith(".");
}

function isManagedProfileName(name) {
  return Boolean(name) && !["missing", "unknown", "unmanaged", "external-link"].includes(name);
}

function isLoginStagingProfile(name) {
  return typeof name === "string" && name.startsWith(LOGIN_STAGING_PREFIX);
}

function createLoginStagingProfileName() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
    String(now.getMilliseconds()).padStart(3, "0")
  ];
  return `${LOGIN_STAGING_PREFIX}${parts.join("")}`;
}

function decodeBase64Url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
}

function extractProfileMeta(auth) {
  const tokens = auth?.tokens || {};
  const idPayload = decodeJwtPayload(tokens.id_token);
  const accessPayload = decodeJwtPayload(tokens.access_token);
  const authMeta =
    idPayload?.["https://api.openai.com/auth"] ||
    accessPayload?.["https://api.openai.com/auth"] ||
    {};
  const profileMeta = accessPayload?.["https://api.openai.com/profile"] || {};

  const email = idPayload?.email || profileMeta.email || null;
  const name = idPayload?.name || null;
  const planType =
    authMeta.chatgpt_plan_type ||
    authMeta.plan_type ||
    null;

  let usageNote = "No official live quota API detected for this profile.";
  if (auth?.auth_mode === "chatgpt") {
    usageNote = "ChatGPT/Codex remaining usage is not exposed through a documented local/API endpoint.";
  } else if (auth?.auth_mode === "api_key") {
    usageNote = "For API-key profiles, check the official Platform billing and usage pages.";
  }

  return {
    authMode: auth?.auth_mode || null,
    email,
    displayName: name,
    planType,
    accountId: tokens.account_id || authMeta.chatgpt_account_id || null,
    lastRefresh: auth?.last_refresh || null,
    usageNote
  };
}

function normalizeVersion(value) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "");
}

function compareVersions(a, b) {
  const left = normalizeVersion(a).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = normalizeVersion(b).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

function getAppBundlePath() {
  return path.dirname(path.dirname(path.dirname(process.execPath)));
}

function isPackagedAppRuntime() {
  return process.platform === "darwin" && getAppBundlePath().endsWith(".app");
}

function pickReleaseAsset(assets = []) {
  if (!Array.isArray(assets) || assets.length === 0) {
    return null;
  }

  const desiredArch = process.arch === "arm64" ? "arm64" : process.arch;
  const lowered = assets.map((asset) => ({
    ...asset,
    lowerName: String(asset?.name || "").toLowerCase()
  }));
  const candidates = [
    (asset) => asset.lowerName.includes(`${desiredArch}.dmg`),
    (asset) => asset.lowerName.includes(`${desiredArch}.zip`),
    (asset) => asset.lowerName.endsWith(".dmg"),
    (asset) => asset.lowerName.endsWith(".zip")
  ];

  for (const matches of candidates) {
    const found = lowered.find(matches);
    if (found) {
      return found;
    }
  }

  return lowered[0] || null;
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsp.rename(tmpPath, filePath);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      IGNORED_WORKSPACE_ROOTS.has(value) ||
      seen.has(value)
    ) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function mergeObjectMaps(baseValue, sourceValue) {
  return {
    ...(isPlainObject(baseValue) ? baseValue : {}),
    ...(isPlainObject(sourceValue) ? sourceValue : {})
  };
}

function filterObjectMapKeys(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !IGNORED_WORKSPACE_ROOTS.has(key))
  );
}

function normalizeThreadWorkspaceRootHints(value) {
  if (!isPlainObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(([threadId, workspaceRoot]) => (
      typeof threadId === "string" &&
      threadId.trim() &&
      typeof workspaceRoot === "string" &&
      workspaceRoot.trim() &&
      !IGNORED_WORKSPACE_ROOTS.has(workspaceRoot)
    ))
  );
}

function mergeThreadTitles(baseValue, sourceValue) {
  const baseTitles = isPlainObject(baseValue?.titles) ? baseValue.titles : {};
  const sourceTitles = isPlainObject(sourceValue?.titles) ? sourceValue.titles : {};
  const mergedTitles = {
    ...baseTitles,
    ...sourceTitles
  };

  return {
    titles: mergedTitles,
    order: uniqueStrings([
      ...(Array.isArray(sourceValue?.order) ? sourceValue.order : []),
      ...(Array.isArray(baseValue?.order) ? baseValue.order : []),
      ...Object.keys(mergedTitles)
    ])
  };
}

function mergeOpenTargetPreferences(baseValue, sourceValue) {
  return {
    global:
      sourceValue?.global ||
      baseValue?.global ||
      "vscode",
    perPath: mergeObjectMaps(
      filterObjectMapKeys(baseValue?.perPath),
      filterObjectMapKeys(sourceValue?.perPath)
    )
  };
}

function mergeGlobalState(baseValue, sourceValue) {
  const baseState = isPlainObject(baseValue) ? baseValue : {};
  const sourceState = isPlainObject(sourceValue) ? sourceValue : {};

  return {
    ...baseState,
    ...sourceState,
    "electron-saved-workspace-roots": uniqueStrings([
      ...(Array.isArray(sourceState["electron-saved-workspace-roots"]) ? sourceState["electron-saved-workspace-roots"] : []),
      ...(Array.isArray(baseState["electron-saved-workspace-roots"]) ? baseState["electron-saved-workspace-roots"] : [])
    ]),
    "active-workspace-roots": uniqueStrings([
      ...(Array.isArray(sourceState["active-workspace-roots"]) ? sourceState["active-workspace-roots"] : []),
      ...(Array.isArray(baseState["active-workspace-roots"]) ? baseState["active-workspace-roots"] : [])
    ]),
    "project-order": uniqueStrings([
      ...(Array.isArray(sourceState["project-order"]) ? sourceState["project-order"] : []),
      ...(Array.isArray(baseState["project-order"]) ? baseState["project-order"] : []),
      ...(Array.isArray(sourceState["electron-saved-workspace-roots"]) ? sourceState["electron-saved-workspace-roots"] : []),
      ...(Array.isArray(baseState["electron-saved-workspace-roots"]) ? baseState["electron-saved-workspace-roots"] : [])
    ]),
    "electron-workspace-root-labels": mergeObjectMaps(
      filterObjectMapKeys(baseState["electron-workspace-root-labels"]),
      filterObjectMapKeys(sourceState["electron-workspace-root-labels"])
    ),
    "electron-persisted-atom-state": mergeObjectMaps(
      baseState["electron-persisted-atom-state"],
      sourceState["electron-persisted-atom-state"]
    ),
    "open-in-target-preferences": mergeOpenTargetPreferences(
      baseState["open-in-target-preferences"],
      sourceState["open-in-target-preferences"]
    ),
    "thread-titles": mergeThreadTitles(
      baseState["thread-titles"],
      sourceState["thread-titles"]
    ),
    "thread-workspace-root-hints": mergeObjectMaps(
      normalizeThreadWorkspaceRootHints(baseState["thread-workspace-root-hints"]),
      normalizeThreadWorkspaceRootHints(sourceState["thread-workspace-root-hints"])
    ),
    "queued-follow-ups": mergeObjectMaps(
      baseState["queued-follow-ups"],
      sourceState["queued-follow-ups"]
    )
  };
}

async function readAutoSwitchConfig() {
  const config = await readJsonIfExists(AUTO_SWITCH_STATE_FILE);
  return {
    enabled: config?.enabled === true,
    updatedAt: config?.updatedAt || null
  };
}

async function setAutoSwitchEnabled(enabled) {
  autoSwitchRuntime.enabled = enabled === true;
  await writeJsonAtomic(AUTO_SWITCH_STATE_FILE, {
    enabled: autoSwitchRuntime.enabled,
    updatedAt: new Date().toISOString()
  });
  return getAutoSwitchPublicState();
}

function getAutoSwitchPublicState() {
  return {
    enabled: autoSwitchRuntime.enabled,
    inFlight: autoSwitchRuntime.inFlight,
    pollIntervalMs: AUTO_SWITCH_POLL_MS,
    cooldownMs: AUTO_SWITCH_COOLDOWN_MS,
    lastCheckAt: autoSwitchRuntime.lastCheckAt,
    lastActionAt: autoSwitchRuntime.lastActionAt,
    lastAction: autoSwitchRuntime.lastAction,
    lastDecision: autoSwitchRuntime.lastDecision,
    lastError: autoSwitchRuntime.lastError
  };
}

function setAutoSwitchDecision(summary, extra = {}) {
  autoSwitchRuntime.lastDecision = {
    summary,
    at: new Date().toISOString(),
    ...extra
  };
}

function formatWindowLabel(windowDurationMins) {
  if (!Number.isFinite(windowDurationMins) || windowDurationMins <= 0) {
    return "Usage limit";
  }
  if (windowDurationMins >= 1440) {
    return "Weekly usage";
  }
  if (windowDurationMins >= 60) {
    const hours = Math.round(windowDurationMins / 60);
    return `${hours}-hour usage`;
  }
  return `${windowDurationMins}-minute usage`;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toIsoFromUnixSeconds(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

function normalizeUsageWindow(window, fallbackName = null) {
  if (!window) {
    return null;
  }

  const usedPercent = clampPercent(window.used_percent);
  const remainingPercent = usedPercent == null ? null : clampPercent(100 - usedPercent);
  const windowDurationMins = Number.isFinite(window.limit_window_seconds)
    ? Math.round(window.limit_window_seconds / 60)
    : null;

  return {
    label: fallbackName || formatWindowLabel(windowDurationMins),
    usedPercent,
    remainingPercent,
    windowDurationMins,
    resetAt: toIsoFromUnixSeconds(window.reset_at)
  };
}

function compareUsageWindowsByConstraint(a, b) {
  const remainingA = clampPercent(a?.remainingPercent);
  const remainingB = clampPercent(b?.remainingPercent);
  if (remainingA == null && remainingB == null) {
    return 0;
  }
  if (remainingA == null) {
    return 1;
  }
  if (remainingB == null) {
    return -1;
  }
  if (remainingA !== remainingB) {
    return remainingA - remainingB;
  }

  const resetA = toTimestamp(a?.resetAt);
  const resetB = toTimestamp(b?.resetAt);
  if (Number.isFinite(resetA) && Number.isFinite(resetB) && resetA !== resetB) {
    return resetA - resetB;
  }
  if (Number.isFinite(resetA) !== Number.isFinite(resetB)) {
    return Number.isFinite(resetA) ? -1 : 1;
  }

  const durationA = Number.isFinite(a?.windowDurationMins) ? a.windowDurationMins : Number.NEGATIVE_INFINITY;
  const durationB = Number.isFinite(b?.windowDurationMins) ? b.windowDurationMins : Number.NEGATIVE_INFINITY;
  if (durationA !== durationB) {
    return durationB - durationA;
  }

  return String(a?.label || "").localeCompare(String(b?.label || ""));
}

function buildUsageSummary(windows, blocked = false) {
  const candidates = Array.isArray(windows)
    ? windows.filter((window) => window && window.remainingPercent != null)
    : [];
  if (!candidates.length) {
    return null;
  }

  const limitingWindow = [...candidates].sort(compareUsageWindowsByConstraint)[0];
  const remainingPercent = clampPercent(limitingWindow.remainingPercent);
  return {
    ...limitingWindow,
    remainingPercent,
    blocked: blocked || remainingPercent === 0,
    aggregate: candidates.length > 1,
    windowCount: candidates.length,
    note: candidates.length > 1 ? "按最紧限制窗口汇总" : null
  };
}

function normalizeUsageResponse(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const primary = normalizeUsageWindow(usage.rate_limit?.primary_window);
  const secondary = normalizeUsageWindow(usage.rate_limit?.secondary_window);
  const codeReview = normalizeUsageWindow(usage.code_review_rate_limit?.primary_window, "Code review usage");
  const additionalLimits = Array.isArray(usage.additional_rate_limits)
    ? usage.additional_rate_limits
        .map((entry) => {
          const label = typeof entry?.limit_name === "string" ? entry.limit_name.trim() : null;
          return {
            label: label || "Additional usage",
            blocked: entry?.rate_limit?.limit_reached === true || entry?.rate_limit?.allowed === false,
            primary: normalizeUsageWindow(entry?.rate_limit?.primary_window, label || null),
            secondary: normalizeUsageWindow(entry?.rate_limit?.secondary_window, label || null)
          };
        })
        .filter((entry) => entry.primary || entry.secondary)
    : [];

  const credits = usage.credits
    ? {
        hasCredits: usage.credits.has_credits === true,
        unlimited: usage.credits.unlimited === true,
        balance: Number.isFinite(usage.credits.balance) ? usage.credits.balance : null
      }
    : null;
  const mainWindows = [primary, secondary].filter(Boolean);
  const blocked = usage.rate_limit?.limit_reached === true
    || usage.rate_limit?.allowed === false
    || mainWindows.some((window) => clampPercent(window.remainingPercent) === 0);
  const summary = buildUsageSummary(mainWindows, blocked)
    || buildUsageSummary([
      codeReview,
      ...additionalLimits.flatMap((entry) => [entry.primary, entry.secondary])
    ]);

  return {
    planType: usage.plan_type || null,
    blocked,
    primary,
    secondary,
    codeReview,
    additionalLimits,
    credits,
    summary
  };
}

function resolvePlanType(metaPlanType, usagePlanType) {
  return usagePlanType || metaPlanType || null;
}

function usageHasSummary(usage) {
  return Boolean(usage && usage.ok !== false && usage.data?.summary && usage.data.summary.remainingPercent != null);
}

function loadUsageSnapshotStore() {
  if (usageSnapshotStore) {
    return usageSnapshotStore;
  }

  try {
    usageSnapshotStore = JSON.parse(fs.readFileSync(USAGE_SNAPSHOT_FILE, "utf8"));
  } catch {
    usageSnapshotStore = {};
  }
  if (!usageSnapshotStore || typeof usageSnapshotStore !== "object" || Array.isArray(usageSnapshotStore)) {
    usageSnapshotStore = {};
  }
  return usageSnapshotStore;
}

function persistUsageSnapshotStore() {
  try {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
    fs.writeFileSync(USAGE_SNAPSHOT_FILE, JSON.stringify(loadUsageSnapshotStore(), null, 2));
  } catch {}
}

function getPersistedUsageSuccess(cacheKey) {
  const snapshot = loadUsageSnapshotStore()[cacheKey];
  if (!usageHasSummary(snapshot)) {
    return null;
  }
  return {
    ok: true,
    data: snapshot.data,
    rawFetchedAt: snapshot.rawFetchedAt || null
  };
}

function setPersistedUsageSuccess(cacheKey, usage) {
  if (!usageHasSummary(usage)) {
    return;
  }
  const store = loadUsageSnapshotStore();
  store[cacheKey] = {
    ok: true,
    data: usage.data,
    rawFetchedAt: usage.rawFetchedAt || null
  };
  persistUsageSnapshotStore();
}

function buildUsageFallbackValue(lastSuccessValue, message) {
  if (!usageHasSummary(lastSuccessValue)) {
    return null;
  }

  return {
    ok: true,
    data: lastSuccessValue.data,
    rawFetchedAt: lastSuccessValue.rawFetchedAt || null,
    fallback: true
  };
}

function buildUsageIssue(message, startedAt, level = "warn") {
  const startedAtMs = toTimestamp(startedAt);
  const showNotice = Number.isFinite(startedAtMs) && (Date.now() - startedAtMs) >= USAGE_FAILURE_NOTICE_AFTER_MS;
  return {
    level,
    message: message || "额度读取失败",
    startedAt: startedAt || null,
    noticeAfterMs: USAGE_FAILURE_NOTICE_AFTER_MS,
    showNotice
  };
}

function toTimestamp(value) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function roundScore(value) {
  return Math.round(value * 10) / 10;
}

function formatDurationLabel(ms) {
  if (!Number.isFinite(ms)) {
    return "重置时间未知";
  }
  if (ms <= 0) {
    return "即将重置";
  }

  const minutes = Math.round(ms / (60 * 1000));
  if (minutes < 60) {
    return `${minutes} 分钟后重置`;
  }

  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours < 48) {
    return `${hours} 小时后重置`;
  }

  const days = ms / (24 * 60 * 60 * 1000);
  return `${days < 5 ? days.toFixed(1) : Math.round(days)} 天后重置`;
}

function formatAgeLabel(seconds) {
  if (!Number.isFinite(seconds)) {
    return "更新时间未知";
  }
  if (seconds < 60) {
    return `${seconds} 秒前更新`;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟前更新`;
  }

  const hours = Math.round(minutes / 60);
  return `${hours} 小时前更新`;
}

function buildUsagePriority(usage, now = Date.now()) {
  if (!usage) {
    return {
      score: -300,
      level: "unknown",
      label: "待确认",
      reason: "还没有拿到额度数据",
      usable: false,
      remainingPercent: null,
      resetAt: null,
      resetInHours: null,
      fetchedAt: null,
      fetchedAgeSeconds: null,
      stale: true
    };
  }

  if (usage.ok === false) {
    return {
      score: -260,
      level: "unknown",
      label: "待确认",
      reason: usage.error || "额度查询失败",
      usable: false,
      remainingPercent: null,
      resetAt: null,
      resetInHours: null,
      fetchedAt: null,
      fetchedAgeSeconds: null,
      stale: true
    };
  }

  const summary = usage.data?.summary;
  if (!summary || summary.remainingPercent == null) {
    return {
      score: -220,
      level: "unknown",
      label: "待确认",
      reason: "当前账号未返回可分析的额度窗口",
      usable: false,
      remainingPercent: null,
      resetAt: null,
      resetInHours: null,
      fetchedAt: usage.rawFetchedAt || null,
      fetchedAgeSeconds: null,
      stale: true
    };
  }

  const remainingPercent = clampPercent(summary.remainingPercent) ?? 0;
  const resetAt = summary.resetAt || null;
  const resetAtMs = toTimestamp(resetAt);
  const resetInHours = Number.isFinite(resetAtMs) ? Math.max(0, (resetAtMs - now) / (60 * 60 * 1000)) : null;
  const fetchedAt = usage.rawFetchedAt || null;
  const fetchedAtMs = toTimestamp(fetchedAt);
  const fetchedAgeSeconds = Number.isFinite(fetchedAtMs)
    ? Math.max(0, Math.round((now - fetchedAtMs) / 1000))
    : null;
  const stale = fetchedAgeSeconds == null || fetchedAgeSeconds > 45;
  const credits = usage.data?.credits;
  const blocked = usage.data?.blocked === true || summary.blocked === true || remainingPercent <= 0;
  const depletionPriority = 100 - remainingPercent;
  const resetPriority = Number.isFinite(resetInHours)
    ? Math.max(0, 168 - Math.min(resetInHours, 168)) / 168 * 100
    : 0;
  const freshnessPenalty = fetchedAgeSeconds == null ? 6 : Math.min(12, fetchedAgeSeconds / 10);
  const score = blocked
    ? -180
    : roundScore((resetPriority * 2) + depletionPriority - freshnessPenalty);

  let level = "low";
  let label = "次选";
  if (blocked) {
    level = "blocked";
    label = "暂不使用";
  } else if (Number.isFinite(resetInHours) && resetInHours <= 72) {
    level = "high";
    label = "建议优先";
  } else if ((Number.isFinite(resetInHours) && resetInHours <= 120) || remainingPercent <= 40) {
    level = "medium";
    label = "可优先";
  }

  const reasonParts = [
    summary.label || null,
    summary.note || null,
    `剩余 ${remainingPercent}%`,
    formatDurationLabel(resetAtMs == null ? NaN : resetAtMs - now),
    formatAgeLabel(fetchedAgeSeconds)
  ].filter(Boolean);
  if (!blocked) {
    reasonParts.push("优先消耗更早重置的账号，其次处理剩余更少的账号");
  }
  if (usage.fallback === true && usage.issue?.message) {
    reasonParts.push(usage.issue.message);
  }
  if (credits?.unlimited) {
    reasonParts.push("附带无限 credit");
  } else if (credits?.hasCredits) {
    reasonParts.push("附带额外 credit");
  }

  return {
    score,
    level,
    label,
    reason: reasonParts.join("，"),
    usable: !blocked,
    remainingPercent,
    resetAt,
    resetInHours: Number.isFinite(resetInHours) ? roundScore(resetInHours) : null,
    depletionPriority: roundScore(depletionPriority),
    fetchedAt,
    fetchedAgeSeconds,
    stale
  };
}

function compareProfilesByPriority(a, b) {
  const usableA = a.priority?.usable === true;
  const usableB = b.priority?.usable === true;
  if (usableA !== usableB) {
    return usableA ? -1 : 1;
  }

  const resetA = Number.isFinite(a.priority?.resetInHours) ? a.priority.resetInHours : Number.POSITIVE_INFINITY;
  const resetB = Number.isFinite(b.priority?.resetInHours) ? b.priority.resetInHours : Number.POSITIVE_INFINITY;
  if (resetA !== resetB) {
    return resetA - resetB;
  }

  const remainingA = Number.isFinite(a.priority?.remainingPercent) ? a.priority.remainingPercent : Number.POSITIVE_INFINITY;
  const remainingB = Number.isFinite(b.priority?.remainingPercent) ? b.priority.remainingPercent : Number.POSITIVE_INFINITY;
  const remainingDelta = remainingA - remainingB;
  if (remainingDelta !== 0) {
    return remainingDelta;
  }

  const scoreDelta = (b.priority?.score || 0) - (a.priority?.score || 0);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const ageA = Number.isFinite(a.priority?.fetchedAgeSeconds) ? a.priority.fetchedAgeSeconds : Number.POSITIVE_INFINITY;
  const ageB = Number.isFinite(b.priority?.fetchedAgeSeconds) ? b.priority.fetchedAgeSeconds : Number.POSITIVE_INFINITY;
  if (ageA !== ageB) {
    return ageA - ageB;
  }

  return String(a.profileName || "").localeCompare(String(b.profileName || ""));
}

function isUsageExhausted(usage) {
  if (!usage || usage.ok === false || !usage.data) {
    return false;
  }

  const remainingPercent = clampPercent(usage.data?.summary?.remainingPercent);
  return usage.data.blocked === true || remainingPercent === 0;
}

function readProxyField(raw, key) {
  const match = String(raw || "").match(new RegExp(`\\b${key}\\s*:\\s*(.+)`));
  return match ? match[1].trim() : "";
}

async function readProxyEnv() {
  if (process.env.http_proxy || process.env.HTTP_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY) {
    return {
      http_proxy: process.env.http_proxy || process.env.HTTP_PROXY || "",
      https_proxy: process.env.https_proxy || process.env.HTTPS_PROXY || "",
      all_proxy: process.env.all_proxy || process.env.ALL_PROXY || ""
    };
  }

  const now = Date.now();
  if (proxyEnvCache.value && proxyEnvCache.expiresAt > now) {
    return proxyEnvCache.value;
  }

  const value = {
    http_proxy: "",
    https_proxy: "",
    all_proxy: ""
  };

  try {
    const { stdout } = await execFileAsync("scutil", ["--proxy"]);
    const httpEnable = readProxyField(stdout, "HTTPEnable");
    const httpsEnable = readProxyField(stdout, "HTTPSEnable");
    const socksEnable = readProxyField(stdout, "SOCKSEnable");
    if (httpEnable === "1") {
      const host = readProxyField(stdout, "HTTPProxy");
      const port = readProxyField(stdout, "HTTPPort");
      if (host && port) {
        value.http_proxy = `http://${host}:${port}`;
      }
    }
    if (httpsEnable === "1") {
      const host = readProxyField(stdout, "HTTPSProxy");
      const port = readProxyField(stdout, "HTTPSPort");
      if (host && port) {
        value.https_proxy = `http://${host}:${port}`;
      }
    }
    if (socksEnable === "1") {
      const host = readProxyField(stdout, "SOCKSProxy");
      const port = readProxyField(stdout, "SOCKSPort");
      if (host && port) {
        value.all_proxy = `socks5://${host}:${port}`;
      }
    }
  } catch {}

  proxyEnvCache.value = value;
  proxyEnvCache.expiresAt = now + 60 * 1000;
  return value;
}

async function curlJson(url, { headers = {}, timeoutMs = null } = {}) {
  const args = ["-sS", "--request", "GET"];
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    args.push("--connect-timeout", String(seconds), "--max-time", String(seconds));
  }

  for (const [name, value] of Object.entries(headers)) {
    args.push("-H", `${name}: ${value}`);
  }

  args.push("-w", "\n%{http_code}", url);
  const proxyEnv = await readProxyEnv();
  let stdout;
  try {
    ({ stdout } = await execFileAsync("curl", args, {
      maxBuffer: 1024 * 1024 * 8,
      env: {
        ...process.env,
        ...proxyEnv
      }
    }));
  } catch (error) {
    const stderr = String(error.stderr || "").trim();
    const sanitized = new Error(
      stderr.includes("Couldn't connect to server")
        ? "Usage endpoint unreachable from current network."
        : stderr || "Usage request failed."
    );
    sanitized.status = null;
    throw sanitized;
  }

  const lines = String(stdout || "").split("\n");
  const statusLine = lines.pop() || "";
  const status = Number.parseInt(statusLine.trim(), 10);
  const bodyText = lines.join("\n").trim();

  let data = null;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    data = bodyText || null;
  }

  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    const message =
      typeof data === "object" && data && "detail" in data ? String(data.detail) :
      typeof data === "object" && data && "error" in data ? String(data.error) :
      typeof data === "string" && data ? data :
      Number.isFinite(status) ? `HTTP ${status}` : "Request failed";
    const error = new Error(message);
    error.status = Number.isFinite(status) ? status : null;
    error.responseBody = data;
    throw error;
  }

  return data;
}

async function downloadFile(url, filePath, { timeoutMs = 60 * 1000 } = {}) {
  const args = ["-L", "--fail", "--silent", "--show-error", "--output", filePath];
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    const seconds = Math.max(5, Math.ceil(timeoutMs / 1000));
    args.push("--connect-timeout", String(Math.min(seconds, 15)), "--max-time", String(seconds));
  }
  args.push(url);

  const proxyEnv = await readProxyEnv();
  await execFileAsync("curl", args, {
    maxBuffer: 1024 * 1024 * 8,
    env: {
      ...process.env,
      ...proxyEnv
    }
  });
}

async function appendUpdaterLogLine(line) {
  try {
    await ensureParentDir(appUpdateRuntime.logPath);
    await fsp.appendFile(appUpdateRuntime.logPath, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {}
}

function getAppUpdateInstallState() {
  return {
    inFlight: appUpdateRuntime.inFlight,
    phase: appUpdateRuntime.phase,
    message: appUpdateRuntime.message,
    error: appUpdateRuntime.error,
    startedAt: appUpdateRuntime.startedAt,
    targetVersion: appUpdateRuntime.targetVersion,
    releaseUrl: appUpdateRuntime.releaseUrl,
    downloadUrl: appUpdateRuntime.downloadUrl,
    assetName: appUpdateRuntime.assetName,
    logPath: appUpdateRuntime.logPath
  };
}

async function readLatestRelease({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && updateCache.value && updateCache.expiresAt > now) {
    return updateCache.value;
  }

  let value;
  try {
    const release = await curlJson(LATEST_RELEASE_API_URL, {
      timeoutMs: 5 * 1000,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "codex-switch-web"
      }
    });
    const asset = pickReleaseAsset(release.assets);
    value = {
      ok: true,
      checkedAt: new Date().toISOString(),
      releaseName: release.name || release.tag_name || null,
      releaseTag: release.tag_name || null,
      latestVersion: normalizeVersion(release.tag_name || release.name || null),
      releaseUrl: release.html_url || RELEASES_URL,
      publishedAt: release.published_at || null,
      assetName: asset?.name || null,
      downloadUrl: asset?.browser_download_url || null
    };
  } catch (error) {
    value = {
      ok: false,
      checkedAt: new Date().toISOString(),
      error: error.message || "检查更新失败",
      releaseUrl: RELEASES_URL,
      latestVersion: null,
      assetName: null,
      downloadUrl: null
    };
  }

  updateCache.value = value;
  updateCache.expiresAt = now + UPDATE_CACHE_TTL_MS;
  return value;
}

async function getAppVersionState({ forceRefresh = false } = {}) {
  const release = await readLatestRelease({ forceRefresh });
  const currentVersion = normalizeVersion(APP_VERSION);
  const latestVersion = normalizeVersion(release.latestVersion);
  const updateAvailable = release.ok && latestVersion && compareVersions(latestVersion, currentVersion) > 0;

  return {
    currentVersion,
    currentVersionLabel: `v${currentVersion}`,
    platform: process.platform,
    arch: process.arch,
    packaged: isPackagedAppRuntime(),
    releasePageUrl: RELEASES_URL,
    update: {
      ...release,
      latestVersion,
      latestVersionLabel: latestVersion ? `v${latestVersion}` : null,
      available: updateAvailable
    },
    install: getAppUpdateInstallState()
  };
}

function buildUpdaterScriptContent() {
  return `#!/bin/zsh
set -euo pipefail

PARENT_PID="$1"
DMG_PATH="$2"
TARGET_APP="$3"
LOG_PATH="$4"
MOUNT_DIR="$(mktemp -d /tmp/codex-switch-update.XXXXXX)"
APP_NAME="$(basename "$TARGET_APP" .app)"

cleanup() {
  /usr/bin/hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
  /bin/rm -rf "$MOUNT_DIR" >/dev/null 2>&1 || true
  /bin/rm -f "$DMG_PATH" >/dev/null 2>&1 || true
  /bin/rm -f "$0" >/dev/null 2>&1 || true
}

trap cleanup EXIT

echo "[$(/bin/date '+%Y-%m-%d %H:%M:%S')] updater start" >>"$LOG_PATH"
/bin/echo "stopping app: $APP_NAME pid=$PARENT_PID" >>"$LOG_PATH"
/bin/sleep 1
/usr/bin/osascript -e "tell application \\"$APP_NAME\\" to quit" >/dev/null 2>&1 || true
/bin/kill -TERM "$PARENT_PID" >/dev/null 2>&1 || true

for _ in {1..8}; do
  if ! /bin/kill -0 "$PARENT_PID" >/dev/null 2>&1; then
    break
  fi
  /bin/sleep 1
done

if /bin/kill -0 "$PARENT_PID" >/dev/null 2>&1; then
  /bin/echo "app still running after graceful quit, forcing stop" >>"$LOG_PATH"
  /bin/kill -KILL "$PARENT_PID" >/dev/null 2>&1 || true
  /usr/bin/pkill -KILL -f "$TARGET_APP/Contents/MacOS/" >/dev/null 2>&1 || true
  /bin/sleep 1
fi

/bin/echo "mounting dmg: $DMG_PATH" >>"$LOG_PATH"

/usr/bin/hdiutil attach "$DMG_PATH" -nobrowse -quiet -mountpoint "$MOUNT_DIR" >>"$LOG_PATH" 2>&1
SOURCE_APP="$MOUNT_DIR/Codex Switch.app"
if [ ! -d "$SOURCE_APP" ]; then
  echo "missing app bundle inside dmg: $SOURCE_APP" >>"$LOG_PATH"
  exit 1
fi

/bin/echo "copying app bundle to: $TARGET_APP" >>"$LOG_PATH"
if ! /usr/bin/ditto "$SOURCE_APP" "$TARGET_APP" >>"$LOG_PATH" 2>&1; then
  /bin/echo "direct copy failed, retrying with administrator privileges" >>"$LOG_PATH"
  /usr/bin/osascript - "$SOURCE_APP" "$TARGET_APP" <<'APPLESCRIPT' >>"$LOG_PATH" 2>&1
on run argv
  set sourceApp to item 1 of argv
  set targetApp to item 2 of argv
  do shell script "/usr/bin/ditto " & quoted form of sourceApp & " " & quoted form of targetApp with administrator privileges
end run
APPLESCRIPT
fi

/bin/echo "relaunching app" >>"$LOG_PATH"
/usr/bin/open -na "$TARGET_APP" >>"$LOG_PATH" 2>&1
/bin/echo "update complete" >>"$LOG_PATH"
`;
}

async function scheduleAppUpdateInstall() {
  if (appUpdateRuntime.inFlight) {
    return {
      ok: true,
      alreadyInProgress: true,
      message: appUpdateRuntime.message || "更新已经在后台进行中",
      install: getAppUpdateInstallState()
    };
  }

  if (!isPackagedAppRuntime()) {
    return {
      ok: false,
      message: "仅 DMG 安装版支持直接更新替换。"
    };
  }

  const versionState = await getAppVersionState({ forceRefresh: true });
  if (!versionState.update.ok) {
    return {
      ok: false,
      message: versionState.update.error || "检查更新失败"
    };
  }

  if (!versionState.update.available) {
    return {
      ok: false,
      message: "当前已经是最新版本。"
    };
  }

  if (!versionState.update.downloadUrl || !String(versionState.update.assetName || "").toLowerCase().endsWith(".dmg")) {
    return {
      ok: false,
      message: "没有找到可直接安装的 DMG 更新包。"
    };
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-switch-update-"));
  const dmgPath = path.join(tmpDir, versionState.update.assetName);
  const scriptPath = path.join(tmpDir, "apply-update.zsh");
  const logPath = appUpdateRuntime.logPath;

  appUpdateRuntime.inFlight = true;
  appUpdateRuntime.phase = "downloading";
  appUpdateRuntime.message = `正在后台下载 ${versionState.update.latestVersionLabel || "更新包"}`;
  appUpdateRuntime.error = null;
  appUpdateRuntime.startedAt = new Date().toISOString();
  appUpdateRuntime.targetVersion = versionState.update.latestVersion || null;
  appUpdateRuntime.releaseUrl = versionState.update.releaseUrl || null;
  appUpdateRuntime.downloadUrl = versionState.update.downloadUrl || null;
  appUpdateRuntime.assetName = versionState.update.assetName || null;

  appUpdateRuntime.task = (async () => {
    try {
      await appendUpdaterLogLine(`background download start: ${versionState.update.assetName}`);
      await downloadFile(versionState.update.downloadUrl, dmgPath, { timeoutMs: APP_UPDATE_DOWNLOAD_TIMEOUT_MS });
      await appendUpdaterLogLine(`background download complete: ${dmgPath}`);
      await fsp.writeFile(scriptPath, buildUpdaterScriptContent(), { mode: 0o755 });

      appUpdateRuntime.phase = "installing";
      appUpdateRuntime.message = `已下载 ${versionState.update.latestVersionLabel || "更新包"}，正在替换应用`;

      const targetAppPath = getAppBundlePath();
      const child = execFile("/bin/zsh", [scriptPath, String(process.pid), dmgPath, targetAppPath, logPath], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();

      appUpdateRuntime.phase = "restarting";
      appUpdateRuntime.message = `正在安装 ${versionState.update.latestVersionLabel || "更新"} 并重启应用`;
    } catch (error) {
      appUpdateRuntime.inFlight = false;
      appUpdateRuntime.phase = "failed";
      appUpdateRuntime.error = error.message || "下载安装更新失败";
      appUpdateRuntime.message = appUpdateRuntime.error;
      appUpdateRuntime.task = null;
      await appendUpdaterLogLine(`background update failed: ${appUpdateRuntime.error}`);
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  })();

  return {
    ok: true,
    message: `已开始后台下载安装 ${versionState.update.latestVersionLabel || versionState.update.releaseTag || "最新版本"}，完成后会自动重启`,
    targetVersion: versionState.update.latestVersion || null,
    releaseUrl: versionState.update.releaseUrl,
    downloadUrl: versionState.update.downloadUrl,
    install: getAppUpdateInstallState()
  };
}

async function readUsageForAuth(auth) {
  if (!auth || auth.auth_mode !== "chatgpt") {
    return null;
  }

  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  if (!accessToken || !accountId) {
    return null;
  }

  return curlJson("https://chatgpt.com/backend-api/wham/usage", {
    timeoutMs: USAGE_FETCH_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      Accept: "application/json",
      "User-Agent": "codex-switch-web"
    }
  });
}

async function readUsageForProfile(name, auth) {
  const cacheKey = name || "__active__";
  const cached = usageCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let value;
  const lastSuccessValue =
    (usageHasSummary(cached?.lastSuccessValue) ? cached.lastSuccessValue : null) ||
    getPersistedUsageSuccess(cacheKey);
  const previousFailureState = cached?.failureState || null;
  let latestLiveSuccessValue = null;
  let nextFailureState = previousFailureState;
  try {
    const raw = await readUsageForAuth(auth);
    const liveValue = raw ? { ok: true, data: normalizeUsageResponse(raw), rawFetchedAt: new Date().toISOString() } : null;
    if (usageHasSummary(liveValue)) {
      latestLiveSuccessValue = liveValue;
      value = liveValue;
      nextFailureState = null;
    } else {
      const startedAt = previousFailureState?.startedAt || new Date().toISOString();
      const message = "当前额度接口没有返回有效数据，正在显示上次成功结果";
      value = buildUsageFallbackValue(lastSuccessValue, message);
      nextFailureState = { startedAt };
      if (value) {
        value.issue = buildUsageIssue(message, startedAt, "warn");
      }
      if (!value) {
        value = {
          ok: false,
          error: "当前账号未返回额度信息",
          issue: buildUsageIssue("当前账号未返回额度信息", startedAt, "warn")
        };
      }
    }
  } catch (error) {
    const errorMessage =
      error.status === 401 || error.status === 403
        ? "额度接口鉴权失败，可能需要重新登录"
        : error.message || "额度查询失败";
    const startedAt = previousFailureState?.startedAt || new Date().toISOString();
    value = buildUsageFallbackValue(lastSuccessValue, `${errorMessage}，正在显示上次成功结果`) || {
      ok: false,
      error: errorMessage
    };
    nextFailureState = { startedAt };
    if (value) {
      value.issue = buildUsageIssue(value.ok === false ? errorMessage : `${errorMessage}，正在显示上次成功结果`, startedAt, value.ok === false ? "danger" : "warn");
    }
  }

  if (usageHasSummary(latestLiveSuccessValue)) {
    setPersistedUsageSuccess(cacheKey, latestLiveSuccessValue);
  }

  usageCache.set(cacheKey, {
    expiresAt: now + USAGE_CACHE_TTL_MS,
    value,
    lastSuccessValue: usageHasSummary(value) ? {
      ok: true,
      data: value.data,
      rawFetchedAt: value.rawFetchedAt || null
    } : lastSuccessValue,
    failureState: nextFailureState
  });
  return value;
}

async function readSessionIndexEntries(limit = LOCAL_SESSION_LIMIT) {
  const filePath = path.join(SHARED_SESSIONS_DIR, "session_index.jsonl");
  if (!await pathExists(filePath)) {
    return [];
  }

  const raw = await fsp.readFile(filePath, "utf8");
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const entry = JSON.parse(trimmed);
      if (!entry?.id) {
        continue;
      }
      entries.push({
        id: String(entry.id),
        threadName: typeof entry.thread_name === "string" ? entry.thread_name.trim() : "",
        updatedAt: entry.updated_at || null
      });
    } catch {}
  }

  entries.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  if (Number.isFinite(limit)) {
    return entries.slice(0, Math.max(0, Number(limit) || 0));
  }
  return entries;
}

function buildSessionIndexEntryFromThreadRow(row) {
  const id = row?.id ? String(row.id) : "";
  if (!id) {
    return null;
  }

  const threadName =
    summarizeThreadName(
      typeof row.thread_name === "string" ? row.thread_name : "",
      typeof row.title === "string" ? row.title : "",
      typeof row.first_user_message === "string" ? row.first_user_message : ""
    ) ||
    `会话 ${id}`;

  return {
    id,
    thread_name: threadName,
    updated_at: toIsoFromUnixSeconds(Number(row.updated_at)) || null
  };
}

async function readThreadRowsForSidebarState(dbPath) {
  if (!await pathExists(dbPath)) {
    return [];
  }

  try {
    const sql = [
      "select id, title, first_user_message, updated_at, cwd",
      "from threads",
      "order by updated_at desc, id desc;"
    ].join(" ");
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql]);
    return stdout.trim() ? JSON.parse(stdout) : [];
  } catch {
    return [];
  }
}

function buildThreadOrderFromRows(threadRows, indexMap) {
  const orderedIds = threadRows
    .map((row) => String(row?.id || ""))
    .filter(Boolean);
  if (orderedIds.length > 0) {
    return orderedIds;
  }

  return [...(indexMap?.values?.() || [])]
    .sort((a, b) => {
      const dateOrder = String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
      if (dateOrder !== 0) {
        return dateOrder;
      }
      return String(a.id || "").localeCompare(String(b.id || ""));
    })
    .map((entry) => entry.id);
}

function normalizeElectronPersistedAtomState(value) {
  const nextState = isPlainObject(value) ? { ...value } : {};

  nextState[SIDEBAR_WORKSPACE_FILTER_KEY] = "all";
  nextState[SIDEBAR_ORGANIZE_MODE_KEY] = "project";
  nextState[THREAD_SORT_ATOM_KEY] = "updated_at";
  nextState["sidebar-collapsed-groups"] = filterObjectMapKeys(nextState["sidebar-collapsed-groups"]);

  return nextState;
}

function extractReadableThreadLine(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    return "";
  }

  const cleaned = rawText
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "\n")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/\r/g, "\n");

  const lines = cleaned
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^https?:\/\/\S+$/i.test(line) && lines[index + 1]) {
      return lines[index + 1];
    }
    if (/^(askuserquestion|enterplanmode|enterworktree|exitplanmode|exitworktree|notebookedit|taskoutput|taskstop|todowrite|webfetch)$/i.test(line)) {
      continue;
    }
    return line;
  }

  return "";
}

function summarizeThreadName(...values) {
  for (const value of values) {
    const line = extractReadableThreadLine(value);
    if (!line) {
      continue;
    }
    if (line.length <= 120) {
      return line;
    }
    return `${line.slice(0, 117).trimEnd()}...`;
  }
  return "";
}

function isWorkspaceRootMatch(cwd, root) {
  if (!cwd || !root) {
    return false;
  }
  return cwd === root || cwd.startsWith(`${root}${path.sep}`);
}

function resolveWorkspaceRoot(cwd, workspaceRoots) {
  const normalizedCwd = typeof cwd === "string" ? cwd.trim() : "";
  if (!normalizedCwd) {
    return "";
  }

  const matchedRoot = uniqueStrings(workspaceRoots)
    .filter((root) => isWorkspaceRootMatch(normalizedCwd, root))
    .sort((a, b) => b.length - a.length)[0];

  return matchedRoot || normalizedCwd;
}

function scoreThreadNoise(threadName) {
  const title = typeof threadName === "string" ? threadName.trim() : "";
  if (!title) {
    return 10;
  }

  const noisyPatterns = [
    /^reply with\b/i,
    /^reply in exactly\b/i,
    /^please answer in exactly\b/i,
    /^write exactly\b/i,
    /^use the read tool\b/i,
    /^you are an interactive agent\b/i,
    /^你是谁$/u,
    /^你是什么模型$/u,
    /^ok$/i,
    /^[A-Z_]+_OK$/i,
    /^\d{6,}$/u
  ];

  for (const pattern of noisyPatterns) {
    if (pattern.test(title)) {
      return 100;
    }
  }

  if (/exactly/i.test(title) || /nothing else/i.test(title)) {
    return 80;
  }

  return 0;
}

function compareThreadOrderEntries(left, right) {
  const noiseOrder = Number(left.noiseScore || 0) - Number(right.noiseScore || 0);
  if (noiseOrder !== 0) {
    return noiseOrder;
  }

  const dateOrder = String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  if (dateOrder !== 0) {
    return dateOrder;
  }

  return String(left.id).localeCompare(String(right.id));
}

function compareThreadActivityEntries(left, right) {
  const activityOrder = Number(right.activityTs || 0) - Number(left.activityTs || 0);
  if (activityOrder !== 0) {
    return activityOrder;
  }

  return String(right.id || "").localeCompare(String(left.id || ""));
}

function buildRoundRobinThreadOrder(entries, preferredWorkspaceRoots) {
  return [...entries]
    .sort(compareThreadActivityEntries)
    .map((entry) => entry.id);
}

async function readThreadActivityMap(dbPath) {
  if (!await pathExists(dbPath)) {
    return new Map();
  }

  try {
    const sql = [
      "select thread_id, max(ts) as max_ts",
      "from logs",
      "where thread_id is not null",
      "group by thread_id;"
    ].join(" ");
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql]);
    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    return new Map(
      rows
        .map((row) => [String(row?.thread_id || ""), Number(row?.max_ts) || 0])
        .filter(([threadId, maxTs]) => threadId && maxTs > 0)
    );
  } catch {
    return new Map();
  }
}

function resolveThreadActivityTimestamp(row, activityMap) {
  const threadId = row?.id ? String(row.id) : "";
  const logTs = threadId ? Number(activityMap.get(threadId) || 0) : 0;
  const createdAt = Number(row?.created_at) || 0;
  return Math.max(logTs, createdAt);
}

async function readSessionIndexMap(filePath) {
  const merged = new Map();
  if (!await pathExists(filePath)) {
    return merged;
  }

  const raw = await fsp.readFile(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const entry = JSON.parse(trimmed);
      if (!entry?.id) {
        continue;
      }
      const normalized = {
        id: String(entry.id),
        thread_name: typeof entry.thread_name === "string" ? entry.thread_name : "",
        updated_at: entry.updated_at || null
      };
      const previous = merged.get(normalized.id);
      if (!previous || String(normalized.updated_at || "") >= String(previous.updated_at || "")) {
        merged.set(normalized.id, normalized);
      }
    } catch {}
  }

  return merged;
}

async function writeSessionIndexMap(filePath, rowsMap) {
  const preferredOrder = arguments.length > 2 ? arguments[2] : null;
  const content = buildSessionIndexContent(rowsMap, preferredOrder);
  await ensureParentDir(filePath);
  try {
    const currentContent = await fsp.readFile(filePath, "utf8");
    if (currentContent === content) {
      return false;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(tmpPath, content, "utf8");
  await fsp.rename(tmpPath, filePath);
  return true;
}

function buildSessionIndexContent(rowsMap, preferredOrder = null) {
  const orderedIds = Array.isArray(preferredOrder) ? preferredOrder : [];
  const seen = new Set();
  const rows = [];

  for (const id of orderedIds) {
    const normalizedId = String(id || "");
    if (!normalizedId || seen.has(normalizedId)) {
      continue;
    }
    const row = rowsMap.get(normalizedId);
    if (!row) {
      continue;
    }
    rows.push(row);
    seen.add(normalizedId);
  }

  const leftovers = [...rowsMap.values()].filter((row) => !seen.has(String(row.id)));
  leftovers.sort((a, b) => {
    const dateOrder = String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
    if (dateOrder !== 0) {
      return dateOrder;
    }
    return String(a.id).localeCompare(String(b.id));
  });

  rows.push(...leftovers);

  return rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
}

async function backfillSessionIndexFromStateDb(sessionIndexPath, dbPath, globalStatePath = null) {
  if (!await pathExists(dbPath)) {
    return 0;
  }

  const rowsMap = await readSessionIndexMap(sessionIndexPath);
  const threadRows = await readThreadRowsForSidebarState(dbPath);
  if (threadRows.length === 0) {
    return 0;
  }

  let changed = 0;
  for (const row of threadRows) {
    const entry = buildSessionIndexEntryFromThreadRow(row);
    if (!entry) {
      continue;
    }

    const previous = rowsMap.get(entry.id);
    const isSame =
      previous &&
      previous.thread_name === entry.thread_name &&
      String(previous.updated_at || "") === String(entry.updated_at || "");
    if (isSame) {
      continue;
    }

    rowsMap.set(entry.id, entry);
    changed += 1;
  }

  const preferredOrder = buildThreadOrderFromRows(threadRows, rowsMap);
  const wrote = await writeSessionIndexMap(sessionIndexPath, rowsMap, preferredOrder);
  return wrote ? Math.max(changed, 1) : 0;
}

async function backfillThreadTitlesInGlobalState(globalStatePath, sessionIndexPath, dbPath) {
  const indexMap = await readSessionIndexMap(sessionIndexPath);
  const threadRows = await readThreadRowsForSidebarState(dbPath);
  if (indexMap.size === 0 && threadRows.length === 0) {
    return 0;
  }

  const state = await readJsonIfExists(globalStatePath);
  const baseState = isPlainObject(state) ? { ...state } : {};
  const currentThreadTitles = isPlainObject(baseState["thread-titles"]) ? baseState["thread-titles"] : {};
  const currentTitles = isPlainObject(currentThreadTitles.titles) ? { ...currentThreadTitles.titles } : {};
  const currentOrder = Array.isArray(currentThreadTitles.order) ? currentThreadTitles.order : [];
  const currentHints = normalizeThreadWorkspaceRootHints(baseState["thread-workspace-root-hints"]);
  const currentLabels = filterObjectMapKeys(baseState["electron-workspace-root-labels"]);

  let changedCount = 0;
  for (const entry of indexMap.values()) {
    if (!entry.thread_name || currentTitles[entry.id] === entry.thread_name) {
      continue;
    }
    currentTitles[entry.id] = entry.thread_name;
    changedCount += 1;
  }

  const sortedIds = buildThreadOrderFromRows(threadRows, indexMap);

  const nextThreadTitles = {
    titles: currentTitles,
    order: uniqueStrings([
      ...sortedIds,
      ...currentOrder,
      ...Object.keys(currentTitles)
    ])
  };
  const knownWorkspaceRoots = getKnownWorkspaceRoots(baseState);
  const nextHints = { ...currentHints };
  for (const row of threadRows) {
    const threadId = row?.id ? String(row.id) : "";
    const cwd = typeof row?.cwd === "string" ? row.cwd.trim() : "";
    if (!threadId || !cwd) {
      continue;
    }

    const workspaceRoot = resolveWorkspaceRoot(cwd, knownWorkspaceRoots);
    if (!workspaceRoot || nextHints[threadId] === workspaceRoot) {
      continue;
    }

    nextHints[threadId] = workspaceRoot;
    changedCount += 1;
  }

  const nextLabels = { ...currentLabels };
  const allDiscoveredRoots = uniqueStrings(Object.values(nextHints));
  for (const workspaceRoot of allDiscoveredRoots) {
    if (nextLabels[workspaceRoot]) {
      continue;
    }
    nextLabels[workspaceRoot] = getWorkspaceRootLabel(workspaceRoot);
    changedCount += 1;
  }

  // Ensure all workspace roots with sessions are registered in electron-saved-workspace-roots
  // so the Codex App sidebar recognizes them as projects.
  const currentSavedRoots = Array.isArray(baseState["electron-saved-workspace-roots"])
    ? baseState["electron-saved-workspace-roots"]
    : [];
  const nextSavedRoots = uniqueStrings([...currentSavedRoots, ...allDiscoveredRoots]);
  const nextProjectOrder = uniqueStrings([
    ...(Array.isArray(baseState["project-order"]) ? baseState["project-order"] : []),
    ...nextSavedRoots
  ]);

  const nextPersistedAtomState = normalizeElectronPersistedAtomState(
    baseState["electron-persisted-atom-state"]
  );

  const changed =
    JSON.stringify(currentThreadTitles.titles || {}) !== JSON.stringify(nextThreadTitles.titles) ||
    JSON.stringify(currentThreadTitles.order || []) !== JSON.stringify(nextThreadTitles.order) ||
    JSON.stringify(currentHints) !== JSON.stringify(nextHints) ||
    JSON.stringify(currentLabels) !== JSON.stringify(nextLabels) ||
    JSON.stringify(currentSavedRoots) !== JSON.stringify(nextSavedRoots) ||
    JSON.stringify(baseState["electron-persisted-atom-state"] || {}) !== JSON.stringify(nextPersistedAtomState);

  if (!changed) {
    return 0;
  }

  baseState["thread-titles"] = nextThreadTitles;
  baseState["thread-workspace-root-hints"] = nextHints;
  baseState["electron-workspace-root-labels"] = nextLabels;
  baseState["electron-saved-workspace-roots"] = nextSavedRoots;
  baseState["project-order"] = nextProjectOrder;
  baseState["electron-persisted-atom-state"] = nextPersistedAtomState;
  await writeJsonAtomic(globalStatePath, baseState);
  return changedCount;
}

// Re-align the shared DB's updated_at ordering to true thread recency so
// Codex desktop shows the latest sessions first while preserving project grouping.
async function realignThreadUpdatedAtToGlobalOrder(dbPath, globalStatePath) {
  if (!await pathExists(dbPath)) {
    return 0;
  }

  let threadRows = [];
  const activityMap = await readThreadActivityMap(dbPath);
  try {
    const sql = [
      "select id, updated_at, created_at",
      "from threads",
      "order by updated_at desc, id desc;"
    ].join(" ");
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql]);
    threadRows = stdout.trim() ? JSON.parse(stdout) : [];
  } catch {
    return 0;
  }

  if (threadRows.length === 0) {
    return 0;
  }

  const rowsById = new Map();
  for (const row of threadRows) {
    const id = row?.id ? String(row.id) : "";
    if (!id) {
      continue;
    }
    rowsById.set(id, row);
  }

  const assignments = [];
  for (const row of threadRows) {
    const id = String(row?.id || "");
    if (!id) {
      continue;
    }
    const targetUpdatedAt = Math.max(1, resolveThreadActivityTimestamp(row, activityMap) || Number(row?.updated_at) || 1);
    const currentUpdatedAt = Number(rowsById.get(id)?.updated_at) || 0;
    if (currentUpdatedAt !== targetUpdatedAt) {
      assignments.push({ id, updatedAt: targetUpdatedAt });
    }
  }

  if (assignments.length === 0) {
    return 0;
  }

  const whenClauses = assignments
    .map((item) => `WHEN ${sqlLiteral(item.id)} THEN ${item.updatedAt}`)
    .join("\n");
  const whereIds = assignments.map((item) => sqlLiteral(item.id)).join(", ");
  const script = [
    "BEGIN IMMEDIATE;",
    "UPDATE threads",
    "SET updated_at = CASE id",
    whenClauses,
    "ELSE updated_at END",
    `WHERE id IN (${whereIds});`,
    "COMMIT;",
    "PRAGMA wal_checkpoint(TRUNCATE);"
  ].join("\n");

  await execFileAsync("sqlite3", [dbPath, script]);
  return assignments.length;
}

async function promoteWorkspaceRepresentativeThreadsToSeedPage(
  dbPath,
  globalStatePath,
  seedLimit = RECENT_CONVERSATION_SEED_LIMIT
) {
  return 0;
}

async function rebalanceSharedSessionPresentation() {
  return 0;
}

async function readLocalSessions(limit = LOCAL_SESSION_LIMIT) {
  return readSharedSessions(limit);
}

async function readSharedSessions(limit = LOCAL_SESSION_LIMIT) {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(0, Number(limit) || 0) : null;
  const indexEntries = await readSessionIndexEntries(normalizedLimit);
  const indexById = new Map(indexEntries.map((entry) => [entry.id, entry]));
  const dbPath = path.join(SHARED_SESSIONS_DIR, "state_5.sqlite");
  let threadRows = [];

  if (await pathExists(dbPath)) {
    try {
      const sqlParts = [
        "select id, updated_at, cwd, source, archived, rollout_path, model_provider, model",
        "from threads",
        "order by updated_at desc"
      ];
      if (normalizedLimit != null) {
        sqlParts.push(`limit ${Math.max(normalizedLimit * 2, normalizedLimit)};`);
      } else {
        sqlParts.push(";");
      }
      const sql = sqlParts.join(" ");
      const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql]);
      threadRows = stdout.trim() ? JSON.parse(stdout) : [];
    } catch {
      threadRows = [];
    }
  }

  const merged = new Map();
  for (const row of threadRows) {
    const index = indexById.get(String(row.id));
    const updatedAt = toIsoFromUnixSeconds(Number(row.updated_at)) || index?.updatedAt || null;
    merged.set(String(row.id), {
      id: String(row.id),
      title: index?.threadName || `会话 ${row.id}`,
      updatedAt,
      cwd: row.cwd || "",
      source: row.source || "",
      archived: row.archived === 1,
      rolloutPath: row.rollout_path || "",
      modelProvider: row.model_provider || "",
      model: row.model || ""
    });
  }

  for (const entry of indexEntries) {
    if (merged.has(entry.id)) {
      continue;
    }
    merged.set(entry.id, {
      id: entry.id,
      title: entry.threadName || `会话 ${entry.id}`,
      updatedAt: entry.updatedAt || null,
      cwd: "",
      source: "",
      archived: false,
      rolloutPath: "",
      modelProvider: "",
      model: ""
    });
  }

  const ordered = [...merged.values()]
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  if (normalizedLimit != null) {
    return ordered.slice(0, normalizedLimit);
  }
  return ordered;
}

function getKnownWorkspaceRoots(globalState) {
  return uniqueStrings([
    ...(Array.isArray(globalState?.["project-order"]) ? globalState["project-order"] : []),
    ...(Array.isArray(globalState?.["electron-saved-workspace-roots"]) ? globalState["electron-saved-workspace-roots"] : []),
    ...(Array.isArray(globalState?.["active-workspace-roots"]) ? globalState["active-workspace-roots"] : [])
  ]);
}

function getWorkspaceRootLabel(workspaceRoot) {
  const normalizedRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  if (!normalizedRoot) {
    return "未分组";
  }

  const label = path.basename(normalizedRoot);
  return label || normalizedRoot;
}

function buildSessionBrowserPayload(sessions, globalState) {
  const knownWorkspaceRoots = getKnownWorkspaceRoots(globalState);
  const sidebarSeedIds = new Set(
    sessions
      .slice(0, RECENT_CONVERSATION_SEED_LIMIT)
      .map((session) => String(session.id || ""))
      .filter(Boolean)
  );
  const projectRank = new Map(knownWorkspaceRoots.map((root, index) => [root, index]));
  const projectsByRoot = new Map();

  for (const session of sessions) {
    const workspaceRoot = resolveWorkspaceRoot(session.cwd, knownWorkspaceRoots);
    const projectKey = workspaceRoot || `cwd:${session.cwd || ""}` || `id:${session.id}`;
    const sidebarSeeded = sidebarSeedIds.has(String(session.id || ""));

    if (!projectsByRoot.has(projectKey)) {
      projectsByRoot.set(projectKey, {
        workspaceRoot,
        label: getWorkspaceRootLabel(workspaceRoot || session.cwd || ""),
        totalCount: 0,
        sidebarCount: 0,
        hiddenCount: 0,
        latestUpdatedAt: session.updatedAt || null,
        sessions: []
      });
    }

    const project = projectsByRoot.get(projectKey);
    project.totalCount += 1;
    if (sidebarSeeded) {
      project.sidebarCount += 1;
    }
    if (!project.latestUpdatedAt || String(session.updatedAt || "") > String(project.latestUpdatedAt || "")) {
      project.latestUpdatedAt = session.updatedAt || project.latestUpdatedAt;
    }
    project.sessions.push({
      ...session,
      workspaceRoot,
      sidebarSeeded
    });
  }

  const projects = [...projectsByRoot.values()]
    .map((project) => ({
      ...project,
      hiddenCount: Math.max(project.totalCount - project.sidebarCount, 0)
    }))
    .sort((left, right) => {
      const leftRank = left.workspaceRoot && projectRank.has(left.workspaceRoot)
        ? projectRank.get(left.workspaceRoot)
        : Number.MAX_SAFE_INTEGER;
      const rightRank = right.workspaceRoot && projectRank.has(right.workspaceRoot)
        ? projectRank.get(right.workspaceRoot)
        : Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      const dateOrder = String(right.latestUpdatedAt || "").localeCompare(String(left.latestUpdatedAt || ""));
      if (dateOrder !== 0) {
        return dateOrder;
      }
      return String(left.label || "").localeCompare(String(right.label || ""));
    });

  return {
    summary: {
      totalSessions: sessions.length,
      totalProjects: projects.length,
      sidebarWindowSize: RECENT_CONVERSATION_SEED_LIMIT,
      visibleProjects: projects.filter((project) => project.sidebarCount > 0).length,
      hiddenSessions: Math.max(sessions.length - Math.min(sessions.length, RECENT_CONVERSATION_SEED_LIMIT), 0)
    },
    projects
  };
}

async function readSessionBrowserState() {
  const sessionIndexPath = path.join(SHARED_SESSIONS_DIR, "session_index.jsonl");
  const dbPath = path.join(SHARED_SESSIONS_DIR, "state_5.sqlite");

  await backfillSessionIndexFromStateDb(sessionIndexPath, dbPath, SHARED_GLOBAL_STATE_PATH);
  await backfillThreadTitlesInGlobalState(SHARED_GLOBAL_STATE_PATH, sessionIndexPath, dbPath);

  const globalState = await readJsonIfExists(SHARED_GLOBAL_STATE_PATH);
  const sessions = await readSharedSessions(null);
  return buildSessionBrowserPayload(sessions, globalState);
}

async function findSharedSessionById(sessionId) {
  const normalizedId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedId) {
    return null;
  }

  const sessions = await readSharedSessions(null);
  return sessions.find((session) => session.id === normalizedId) || null;
}

function isPathWithin(basePath, targetPath) {
  const normalizedBase = path.resolve(basePath);
  const normalizedTarget = path.resolve(targetPath);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
}

function isSessionArtifactPath(targetPath) {
  const normalizedTarget = typeof targetPath === "string" ? path.resolve(targetPath) : "";
  if (!normalizedTarget) {
    return false;
  }

  const allowedRoots = [
    path.join(SHARED_SESSIONS_DIR, "sessions"),
    path.join(SHARED_SESSIONS_DIR, "shell_snapshots"),
    path.join(ACTIVE_CODEX_DIR, "sessions"),
    path.join(ACTIVE_CODEX_DIR, "shell_snapshots")
  ];
  return allowedRoots.some((rootPath) => isPathWithin(rootPath, normalizedTarget));
}

async function collectFilesContainingText(rootDir, needle) {
  const normalizedNeedle = typeof needle === "string" ? needle.trim() : "";
  if (!normalizedNeedle || !await pathExists(rootDir)) {
    return [];
  }

  const matches = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.includes(normalizedNeedle)) {
        matches.push(fullPath);
      }
    }
  }

  return matches;
}

async function removeThreadFromSharedGlobalState(threadId) {
  const normalizedId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedId) {
    return false;
  }

  const state = await readJsonIfExists(SHARED_GLOBAL_STATE_PATH);
  if (!isPlainObject(state)) {
    return false;
  }

  let changed = false;
  const nextState = { ...state };

  const threadTitles = isPlainObject(nextState["thread-titles"]) ? { ...nextState["thread-titles"] } : null;
  if (threadTitles) {
    const titles = isPlainObject(threadTitles.titles) ? { ...threadTitles.titles } : {};
    const order = Array.isArray(threadTitles.order) ? threadTitles.order : [];
    if (Object.prototype.hasOwnProperty.call(titles, normalizedId)) {
      delete titles[normalizedId];
      changed = true;
    }
    const nextOrder = order.filter((id) => String(id || "") !== normalizedId);
    if (nextOrder.length !== order.length) {
      changed = true;
    }
    threadTitles.titles = titles;
    threadTitles.order = nextOrder;
    nextState["thread-titles"] = threadTitles;
  }

  if (isPlainObject(nextState["thread-workspace-root-hints"]) && Object.prototype.hasOwnProperty.call(nextState["thread-workspace-root-hints"], normalizedId)) {
    const nextHints = { ...nextState["thread-workspace-root-hints"] };
    delete nextHints[normalizedId];
    nextState["thread-workspace-root-hints"] = nextHints;
    changed = true;
  }

  if (isPlainObject(nextState["queued-follow-ups"]) && Object.prototype.hasOwnProperty.call(nextState["queued-follow-ups"], normalizedId)) {
    const nextQueued = { ...nextState["queued-follow-ups"] };
    delete nextQueued[normalizedId];
    nextState["queued-follow-ups"] = nextQueued;
    changed = true;
  }

  if (Array.isArray(nextState["pinned-thread-ids"])) {
    const previous = nextState["pinned-thread-ids"];
    const nextPinned = previous.filter((id) => String(id || "") !== normalizedId);
    if (nextPinned.length !== previous.length) {
      nextState["pinned-thread-ids"] = nextPinned;
      changed = true;
    }
  }

  const atomState = isPlainObject(nextState["electron-persisted-atom-state"])
    ? { ...nextState["electron-persisted-atom-state"] }
    : null;
  if (atomState && Array.isArray(atomState["pinned-thread-ids"])) {
    const previousPinned = atomState["pinned-thread-ids"];
    const nextPinned = previousPinned.filter((id) => String(id || "") !== normalizedId);
    if (nextPinned.length !== previousPinned.length) {
      atomState["pinned-thread-ids"] = nextPinned;
      nextState["electron-persisted-atom-state"] = atomState;
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }

  await writeJsonAtomic(SHARED_GLOBAL_STATE_PATH, nextState);
  return true;
}

async function deleteSharedSessionById(sessionId) {
  const normalizedId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedId) {
    return {
      ok: false,
      error: "Invalid session id"
    };
  }

  const session = await findSharedSessionById(normalizedId);
  if (!session) {
    return {
      ok: false,
      notFound: true,
      error: "Session not found"
    };
  }

  const stateDbPath = path.join(SHARED_SESSIONS_DIR, "state_5.sqlite");
  const logsDbPath = path.join(SHARED_SESSIONS_DIR, "logs_1.sqlite");
  const sessionIndexPath = path.join(SHARED_SESSIONS_DIR, "session_index.jsonl");
  const threadIdLiteral = sqlLiteral(normalizedId);

  if (await pathExists(stateDbPath)) {
    const deleteScript = [
      "PRAGMA foreign_keys = ON;",
      "BEGIN IMMEDIATE;",
      `DELETE FROM thread_dynamic_tools WHERE thread_id = ${threadIdLiteral};`,
      `DELETE FROM stage1_outputs WHERE thread_id = ${threadIdLiteral};`,
      `DELETE FROM thread_spawn_edges WHERE child_thread_id = ${threadIdLiteral} OR parent_thread_id = ${threadIdLiteral};`,
      `DELETE FROM agent_job_items WHERE assigned_thread_id = ${threadIdLiteral};`,
      `DELETE FROM logs WHERE thread_id = ${threadIdLiteral};`,
      `DELETE FROM threads WHERE id = ${threadIdLiteral};`,
      "COMMIT;",
      "PRAGMA wal_checkpoint(TRUNCATE);"
    ].join("\n");
    await execFileAsync("sqlite3", [stateDbPath, deleteScript]);
  }

  if (await pathExists(logsDbPath)) {
    const deleteLogsScript = [
      "BEGIN IMMEDIATE;",
      `DELETE FROM logs WHERE thread_id = ${threadIdLiteral};`,
      "COMMIT;",
      "PRAGMA wal_checkpoint(TRUNCATE);"
    ].join("\n");
    await execFileAsync("sqlite3", [logsDbPath, deleteLogsScript]);
  }

  const rowsMap = await readSessionIndexMap(sessionIndexPath);
  const hadIndexEntry = rowsMap.delete(normalizedId);
  let wroteSessionIndex = false;
  if (hadIndexEntry) {
    wroteSessionIndex = await writeSessionIndexMap(sessionIndexPath, rowsMap);
  }

  const wroteGlobalState = await removeThreadFromSharedGlobalState(normalizedId);

  const artifactCandidates = new Set();
  const rolloutPath = typeof session.rolloutPath === "string" ? session.rolloutPath.trim() : "";
  if (rolloutPath) {
    artifactCandidates.add(path.resolve(rolloutPath));
  }

  for (const matchedPath of await collectFilesContainingText(path.join(SHARED_SESSIONS_DIR, "sessions"), normalizedId)) {
    artifactCandidates.add(path.resolve(matchedPath));
  }
  for (const matchedPath of await collectFilesContainingText(path.join(SHARED_SESSIONS_DIR, "shell_snapshots"), normalizedId)) {
    artifactCandidates.add(path.resolve(matchedPath));
  }

  let deletedFiles = 0;
  for (const targetPath of artifactCandidates) {
    if (!isSessionArtifactPath(targetPath) || !await pathExists(targetPath)) {
      continue;
    }
    try {
      await fsp.unlink(targetPath);
      deletedFiles += 1;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  await backfillThreadTitlesInGlobalState(
    SHARED_GLOBAL_STATE_PATH,
    sessionIndexPath,
    stateDbPath
  );

  return {
    ok: true,
    id: normalizedId,
    title: session.title || normalizedId,
    deletedFiles,
    wroteSessionIndex,
    wroteGlobalState
  };
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

function isHomeRelativePath(targetPath) {
  const normalizedPath = typeof targetPath === "string" ? path.resolve(targetPath) : "";
  if (!normalizedPath) {
    return false;
  }

  const homePath = os.homedir();
  return normalizedPath === homePath || normalizedPath.startsWith(`${homePath}${path.sep}`);
}

async function pathExists(targetPath) {
  try {
    await fsp.lstat(targetPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readLinkRealPath(targetPath) {
  try {
    return await fsp.realpath(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function ensureParentDir(targetPath) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
}

async function ensureDir(targetPath) {
  await fsp.mkdir(targetPath, { recursive: true });
}

async function ensureEmptyFile(targetPath) {
  await ensureParentDir(targetPath);
  if (!await pathExists(targetPath)) {
    await fsp.writeFile(targetPath, "", "utf8");
  }
}

function getProfileDir(name) {
  return path.join(PROFILES_DIR, name);
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildSqliteMergeScript(kind, srcDbPath) {
  const attach = `ATTACH DATABASE ${sqlLiteral(srcDbPath)} AS src;`;
  if (kind === "logs") {
    return [
      attach,
      "BEGIN IMMEDIATE;",
      "INSERT OR IGNORE INTO main._sqlx_migrations SELECT * FROM src._sqlx_migrations;",
      "INSERT INTO main.logs(ts, ts_nanos, level, target, feedback_log_body, module_path, file, line, thread_id, process_uuid, estimated_bytes)",
      "SELECT ts, ts_nanos, level, target, feedback_log_body, module_path, file, line, thread_id, process_uuid, estimated_bytes FROM src.logs;",
      "COMMIT;",
      "DETACH DATABASE src;",
      "PRAGMA wal_checkpoint(TRUNCATE);"
    ].join("\n");
  }

  return [
    attach,
    "BEGIN IMMEDIATE;",
    "INSERT OR IGNORE INTO main._sqlx_migrations SELECT * FROM src._sqlx_migrations;",
    "INSERT OR IGNORE INTO main.threads SELECT * FROM src.threads;",
    "INSERT INTO main.logs(ts, ts_nanos, level, target, message, module_path, file, line, thread_id, process_uuid, estimated_bytes)",
    "SELECT ts, ts_nanos, level, target, message, module_path, file, line, thread_id, process_uuid, estimated_bytes FROM src.logs;",
    "INSERT OR IGNORE INTO main.thread_dynamic_tools SELECT * FROM src.thread_dynamic_tools;",
    "INSERT OR IGNORE INTO main.stage1_outputs SELECT * FROM src.stage1_outputs;",
    "INSERT OR IGNORE INTO main.jobs SELECT * FROM src.jobs;",
    "INSERT OR IGNORE INTO main.backfill_state SELECT * FROM src.backfill_state;",
    "INSERT OR IGNORE INTO main.agent_jobs SELECT * FROM src.agent_jobs;",
    "INSERT OR IGNORE INTO main.agent_job_items SELECT * FROM src.agent_job_items;",
    "INSERT OR IGNORE INTO main.thread_spawn_edges SELECT * FROM src.thread_spawn_edges;",
    "COMMIT;",
    "DETACH DATABASE src;",
    "PRAGMA wal_checkpoint(TRUNCATE);"
  ].join("\n");
}

async function copyFileIfExists(srcPath, destPath) {
  if (!await pathExists(srcPath)) {
    return;
  }
  await ensureParentDir(destPath);
  await fsp.copyFile(srcPath, destPath);
}

async function copySqliteFamily(srcBasePath, destBasePath) {
  const suffixes = ["", "-shm", "-wal"];
  for (const suffix of suffixes) {
    await copyFileIfExists(`${srcBasePath}${suffix}`, `${destBasePath}${suffix}`);
  }
}

function formatBackupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function backupSharedStateDbForRepair(dbPath) {
  if (!await pathExists(dbPath)) {
    return null;
  }

  const backupRoot = path.join(SHARED_REPAIR_BACKUPS_DIR, formatBackupTimestamp());
  await ensureDir(backupRoot);
  await copySqliteFamily(dbPath, path.join(backupRoot, path.basename(dbPath)));
  return backupRoot;
}

async function promoteSharedThreadRecencyForSidebar() {
  const dbPath = path.join(SHARED_SESSIONS_DIR, "state_5.sqlite");
  const sessionIndexPath = path.join(SHARED_SESSIONS_DIR, "session_index.jsonl");
  if (!await pathExists(dbPath)) {
    return {
      ok: true,
      updated: 0,
      totalThreads: 0,
      backupRoot: null
    };
  }

  const threadRows = await readThreadRowsForSidebarState(dbPath);
  if (threadRows.length === 0) {
    return {
      ok: true,
      updated: 0,
      totalThreads: 0,
      backupRoot: null
    };
  }

  const backupRoot = await backupSharedStateDbForRepair(dbPath);
  const updatedCount = await realignThreadUpdatedAtToGlobalOrder(dbPath, SHARED_GLOBAL_STATE_PATH);
  if (updatedCount === 0) {
    return {
      ok: true,
      updated: 0,
      totalThreads: threadRows.length,
      backupRoot
    };
  }

  await backfillSessionIndexFromStateDb(sessionIndexPath, dbPath, SHARED_GLOBAL_STATE_PATH);
  await backfillThreadTitlesInGlobalState(SHARED_GLOBAL_STATE_PATH, sessionIndexPath, dbPath);

  return {
    ok: true,
    updated: updatedCount,
    totalThreads: threadRows.length,
    backupRoot
  };
}

async function mergeGlobalStateFile(sharedPath, sourcePath) {
  if (!await pathExists(sourcePath)) {
    return;
  }

  const sharedRealPath = await readLinkRealPath(sharedPath);
  const sourceRealPath = await readLinkRealPath(sourcePath);
  if (sharedRealPath && sourceRealPath && sharedRealPath === sourceRealPath) {
    return;
  }

  const [sharedState, sourceState] = await Promise.all([
    readJsonIfExists(sharedPath),
    readJsonIfExists(sourcePath)
  ]);

  const mergedState = mergeGlobalState(sharedState, sourceState);
  await writeJsonAtomic(sharedPath, mergedState);
}

async function mergeSqliteDatabase(sharedBasePath, sourceBasePath, kind) {
  if (!await pathExists(sourceBasePath)) {
    return;
  }

  const sharedRealPath = await readLinkRealPath(sharedBasePath);
  const sourceRealPath = await readLinkRealPath(sourceBasePath);
  if (sharedRealPath && sourceRealPath && sharedRealPath === sourceRealPath) {
    return;
  }

  await ensureParentDir(sharedBasePath);
  if (!await pathExists(sharedBasePath)) {
    await copySqliteFamily(sourceBasePath, sharedBasePath);
    return;
  }

  const script = buildSqliteMergeScript(kind, sourceBasePath);
  await execFileAsync("sqlite3", [sharedBasePath, script]);
}

async function mergeSessionIndex(sharedPath, sourcePath) {
  if (!await pathExists(sourcePath)) {
    return;
  }

  const sharedRealPath = await readLinkRealPath(sharedPath);
  const sourceRealPath = await readLinkRealPath(sourcePath);
  if (sharedRealPath && sourceRealPath && sharedRealPath === sourceRealPath) {
    return;
  }

  const merged = new Map();
  for (const filePath of [sharedPath, sourcePath]) {
    const rowsMap = await readSessionIndexMap(filePath);
    for (const [id, entry] of rowsMap.entries()) {
      const previous = merged.get(id);
      if (!previous || String(entry.updated_at || "") >= String(previous.updated_at || "")) {
        merged.set(id, entry);
      }
    }
  }

  await writeSessionIndexMap(sharedPath, merged);
}

async function mergeDirectoryInto(sharedDirPath, sourceDirPath) {
  if (!await pathExists(sourceDirPath)) {
    return;
  }

  const sourceStat = await fsp.lstat(sourceDirPath);
  if (!sourceStat.isDirectory()) {
    return;
  }

  const sharedRealPath = await readLinkRealPath(sharedDirPath);
  const sourceRealPath = await readLinkRealPath(sourceDirPath);
  if (sharedRealPath && sourceRealPath && sharedRealPath === sourceRealPath) {
    return;
  }

  await ensureDir(sharedDirPath);
  await execFileAsync("rsync", ["-a", `${sourceDirPath}/`, `${sharedDirPath}/`]);
}

async function checkpointSqliteIfNeeded(filePath) {
  if (!filePath.endsWith(".sqlite")) {
    return;
  }
  if (!await pathExists(filePath)) {
    return;
  }
  const stat = await fsp.lstat(filePath);
  if (stat.isSymbolicLink()) {
    return;
  }
  try {
    await execFileAsync("sqlite3", [filePath, "PRAGMA wal_checkpoint(TRUNCATE);"]);
  } catch {}
}

async function linkProfileItemToShared(profileDir, itemName) {
  const profileItemPath = path.join(profileDir, itemName);
  const sharedItemPath = path.join(SHARED_SESSIONS_DIR, itemName);
  const profileRealPath = await readLinkRealPath(profileItemPath);
  const sharedRealPath = await readLinkRealPath(sharedItemPath);
  if (profileRealPath && sharedRealPath && profileRealPath === sharedRealPath) {
    return;
  }

  if (SHARED_SESSION_DIRS.includes(itemName)) {
    await ensureDir(sharedItemPath);
  } else if (itemName === "session_index.jsonl") {
    await ensureEmptyFile(sharedItemPath);
  } else {
    await ensureParentDir(sharedItemPath);
  }

  // Flush any pending WAL data before removing the original file
  await checkpointSqliteIfNeeded(profileItemPath);
  await checkpointSqliteIfNeeded(sharedItemPath);

  await fsp.rm(profileItemPath, { recursive: true, force: true });
  await fsp.symlink(sharedItemPath, profileItemPath);
}

async function linkProfileGlobalStateToShared(profileDir) {
  const profileStatePath = path.join(profileDir, GLOBAL_STATE_FILE_NAME);
  const profileRealPath = await readLinkRealPath(profileStatePath);
  const sharedRealPath = await readLinkRealPath(SHARED_GLOBAL_STATE_PATH);
  if (profileRealPath && sharedRealPath && profileRealPath === sharedRealPath) {
    return;
  }

  if (!await pathExists(SHARED_GLOBAL_STATE_PATH)) {
    await writeJsonAtomic(SHARED_GLOBAL_STATE_PATH, {});
  }

  await fsp.rm(profileStatePath, { recursive: true, force: true });
  await fsp.symlink(SHARED_GLOBAL_STATE_PATH, profileStatePath);
}

async function syncSessionArtifactsFromDir(sourceDir) {
  for (const { baseName, kind } of SQLITE_SESSION_DATABASES) {
    await mergeSqliteDatabase(path.join(SHARED_SESSIONS_DIR, baseName), path.join(sourceDir, baseName), kind);
  }

  await mergeSessionIndex(
    path.join(SHARED_SESSIONS_DIR, "session_index.jsonl"),
    path.join(sourceDir, "session_index.jsonl")
  );

  for (const dirName of SHARED_SESSION_DIRS) {
    await mergeDirectoryInto(path.join(SHARED_SESSIONS_DIR, dirName), path.join(sourceDir, dirName));
  }

  await backfillSessionIndexFromStateDb(
    path.join(SHARED_SESSIONS_DIR, "session_index.jsonl"),
    path.join(SHARED_SESSIONS_DIR, "state_5.sqlite"),
    SHARED_GLOBAL_STATE_PATH
  );
}

async function syncGlobalStateFromDir(sourceDir) {
  await mergeGlobalStateFile(
    SHARED_GLOBAL_STATE_PATH,
    path.join(sourceDir, GLOBAL_STATE_FILE_NAME)
  );

  await backfillThreadTitlesInGlobalState(
    SHARED_GLOBAL_STATE_PATH,
    path.join(SHARED_SESSIONS_DIR, "session_index.jsonl"),
    path.join(SHARED_SESSIONS_DIR, "state_5.sqlite")
  );
}

async function ensureSharedSessionsLayout(targetProfileName) {
  await ensureDir(PROFILES_DIR);
  await ensureDir(SHARED_SESSIONS_DIR);

  const activeProfile = await readCurrentProfile();
  const profileNames = await listProfileNames();
  const profilesToLink = new Set(profileNames);
  if (targetProfileName) {
    profilesToLink.add(targetProfileName);
  }

  if (!["missing", "unknown", "unmanaged", "external-link"].includes(activeProfile)) {
    profilesToLink.add(activeProfile);
  }

  if (["missing", "unknown", "unmanaged", "external-link"].includes(activeProfile) && await pathExists(ACTIVE_CODEX_DIR)) {
    await syncSessionArtifactsFromDir(ACTIVE_CODEX_DIR);
    await syncGlobalStateFromDir(ACTIVE_CODEX_DIR);
  }

  for (const profileName of profileNames) {
    const profileDir = getProfileDir(profileName);
    await syncSessionArtifactsFromDir(profileDir);
    await syncGlobalStateFromDir(profileDir);
  }

  for (const profileName of profilesToLink) {
    const profileDir = getProfileDir(profileName);
    if (!await pathExists(profileDir)) {
      continue;
    }
    for (const itemName of SHARED_SESSION_ITEMS) {
      await linkProfileItemToShared(profileDir, itemName);
    }
    await linkProfileGlobalStateToShared(profileDir);
  }
}

async function listProfileNames() {
  try {
    const entries = await fsp.readdir(PROFILES_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !isInternalProfileName(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function cleanupOrphanLoginStagingProfiles(activeProfile) {
  try {
    const entries = await fsp.readdir(PROFILES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isLoginStagingProfile(entry.name) || entry.name === activeProfile) {
        continue;
      }

      const auth = await readJsonIfExists(path.join(PROFILES_DIR, entry.name, "auth.json"));
      const email = extractProfileMeta(auth).email;
      if (email) {
        continue;
      }

      await fsp.rm(path.join(PROFILES_DIR, entry.name), { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function readCurrentProfile() {
  try {
    const { stdout } = await execFileAsync(getCodexSwitchCommand(), ["current"]);
    return stdout.trim();
  } catch (error) {
    return "unknown";
  }
}

async function readLoginStatus() {
  try {
    const { stdout, stderr } = await execFileAsync("codex", ["login", "status"]);
    return String(stdout || stderr || "").trim();
  } catch (error) {
    return String(error.stdout || error.stderr || error.message || "Unknown").trim();
  }
}

async function readActiveProfileMeta(activeProfile) {
  if (!activeProfile || ["missing", "unknown", "unmanaged", "external-link"].includes(activeProfile)) {
    const auth = await readJsonIfExists(path.join(ACTIVE_CODEX_DIR, "auth.json"));
    return extractProfileMeta(auth);
  }

  const auth = await readJsonIfExists(path.join(PROFILES_DIR, activeProfile, "auth.json"));
  return extractProfileMeta(auth);
}

async function readAuthForProfile(activeProfile, name) {
  if (name && isManagedProfileName(name)) {
    return readJsonIfExists(path.join(PROFILES_DIR, name, "auth.json"));
  }

  if (!activeProfile || !isManagedProfileName(activeProfile)) {
    return readJsonIfExists(path.join(ACTIVE_CODEX_DIR, "auth.json"));
  }

  return readJsonIfExists(path.join(PROFILES_DIR, activeProfile, "auth.json"));
}

async function getProfilesState() {
  await backfillSessionIndexFromStateDb(
    path.join(SHARED_SESSIONS_DIR, "session_index.jsonl"),
    path.join(SHARED_SESSIONS_DIR, "state_5.sqlite"),
    SHARED_GLOBAL_STATE_PATH
  );
  await backfillThreadTitlesInGlobalState(
    SHARED_GLOBAL_STATE_PATH,
    path.join(SHARED_SESSIONS_DIR, "session_index.jsonl"),
    path.join(SHARED_SESSIONS_DIR, "state_5.sqlite")
  );

  const activeProfile = await readCurrentProfile();
  await cleanupOrphanLoginStagingProfiles(activeProfile);
  const loginStatus = await readLoginStatus();
  const activeAccountMeta = await readActiveProfileMeta(activeProfile);
  const activeAuth = await readAuthForProfile(activeProfile);
  const activeUsage = await readUsageForProfile(activeProfile, activeAuth);
  const activeAccount = {
    ...activeAccountMeta,
    planType: resolvePlanType(activeAccountMeta.planType, activeUsage?.data?.planType || null)
  };
  const localSessions = await readLocalSessions();
  const profileNames = await listProfileNames();

  const profiles = await Promise.all(
    profileNames.map(async (name) => {
      const dir = path.join(PROFILES_DIR, name);
      const auth = await readJsonIfExists(path.join(dir, "auth.json"));
      const configExists = fs.existsSync(path.join(dir, "config.toml"));
      const usage = await readUsageForProfile(name, auth);
      const meta = extractProfileMeta(auth);
      return {
        profileName: name,
        path: dir,
        active: name === activeProfile,
        hasAuth: Boolean(auth),
        hasConfig: configExists,
        usage,
        ...meta,
        planType: resolvePlanType(meta.planType, usage?.data?.planType || null)
      };
    })
  );

  const profilesWithPriority = profiles
    .map((profile) => ({
      ...profile,
      priority: buildUsagePriority(profile.usage)
    }))
    .sort(compareProfilesByPriority);

  const recommendedProfile = profilesWithPriority.find((profile) => profile.priority?.usable) || null;

  return {
    activeProfile,
    loginStatus,
    activeAccount,
    activeUsage,
    localSessions,
    autoSwitch: getAutoSwitchPublicState(),
    profilesDir: PROFILES_DIR,
    activeCodexDir: ACTIVE_CODEX_DIR,
    profiles: profilesWithPriority,
    recommendedProfile: recommendedProfile
      ? {
          profileName: recommendedProfile.profileName,
          email: recommendedProfile.email || null,
          ...recommendedProfile.priority
        }
      : null,
    notes: [
      "This UI only supports manual switching.",
      "Close Codex before save/new/use unless you intentionally use --force in the terminal.",
      "Session/thread history is merged into a shared local store before switching profiles.",
      "Live remaining usage for ChatGPT/Codex accounts is not exposed through a documented local/API endpoint."
    ]
  };
}

async function runCodexSwitch(args) {
  try {
    const { stdout, stderr } = await execFileAsync(getCodexSwitchCommand(), args);
    return {
      ok: true,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  } catch (error) {
    const missingBinary = error && error.code === "ENOENT";
    return {
      ok: false,
      stdout: String(error.stdout || "").trim(),
      stderr: String(error.stderr || "").trim(),
      message: missingBinary ? getCodexSwitchInstallHint() : error.message
    };
  }
}

async function renameProfile(oldName, newName) {
  return runCodexSwitch(["rename", oldName, newName]);
}

async function deleteProfile(name) {
  return runCodexSwitch(["delete", name]);
}

async function prepareProfileForLogin() {
  const activeProfile = await readCurrentProfile();
  if (isLoginStagingProfile(activeProfile)) {
    return {
      ok: true,
      changed: false,
      activeProfile
    };
  }

  const processes = await listCodexProcesses();
  if (processes.length > 0) {
    const closeResult = await closeCodexProcesses();
    if (!closeResult.ok) {
      return {
        ok: false,
        changed: false,
        message: "Failed to close Codex-related processes before preparing login"
      };
    }
  }

  const stagingProfile = createLoginStagingProfileName();
  const result = await runCodexSwitch(["new", stagingProfile]);
  if (!result.ok) {
    return {
      ok: false,
      changed: false,
        message: sanitizePublicMessage(result)
    };
  }

  const switchResult = await performProfileSwitch(stagingProfile, {
    closeAndForce: true,
    openCodex: false
  });
  if (!switchResult.ok) {
    return {
      ok: false,
      changed: false,
      message: switchResult.message || `Failed to activate staging profile ${stagingProfile}`
    };
  }

  return {
    ok: true,
    changed: true,
    activeProfile: stagingProfile,
    previousProfile: activeProfile,
    stagingProfile
  };
}

async function autoRegisterActiveProfile() {
  const activeProfile = await readCurrentProfile();
  const activeAccount = await readActiveProfileMeta(activeProfile);
  const email = activeAccount?.email;

  if (!email || !isValidProfileName(email)) {
    return {
      ok: false,
      changed: false,
      message: "Active account email is missing or not usable as a profile name"
    };
  }

  if (activeProfile === email) {
    return {
      ok: true,
      changed: false,
      message: "Active profile already matches the account email"
    };
  }

  const existingProfiles = await listProfileNames();
  if (existingProfiles.includes(email)) {
    return {
      ok: true,
      changed: false,
      message: "An email-named profile already exists"
    };
  }

  if (isLoginStagingProfile(activeProfile)) {
    const result = await renameProfile(activeProfile, email);
    if (result.ok) {
      await ensureSharedSessionsLayout(email);
    }
    return {
      ok: result.ok,
      changed: result.ok,
      message: result.ok ? `Renamed active profile to ${email}` : sanitizePublicMessage(result)
    };
  }

  const result = await runCodexSwitch(["save", email]);
  if (result.ok) {
    await ensureSharedSessionsLayout(email);
  }
  return {
    ok: result.ok,
    changed: result.ok,
    message: result.ok ? `Saved current account as profile ${email}` : sanitizePublicMessage(result)
  };
}

async function openMacTarget(targetArgs) {
  try {
    await execFileAsync("open", targetArgs);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error.message
    };
  }
}

async function openTerminalCommand(command) {
  const escaped = command
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  const script = `tell application "Terminal" to do script "${escaped}"`;
  try {
    await execFileAsync("osascript", ["-e", script, "-e", 'tell application "Terminal" to activate']);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error.message
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForActiveProfile(expectedProfile) {
  let currentProfile = await readCurrentProfile();
  if (currentProfile === expectedProfile) {
    return currentProfile;
  }

  for (let attempt = 0; attempt < PROFILE_POLL_ATTEMPTS; attempt += 1) {
    await sleep(PROFILE_POLL_DELAY_MS);
    currentProfile = await readCurrentProfile();
    if (currentProfile === expectedProfile) {
      return currentProfile;
    }
  }

  return currentProfile;
}

function classifyCodexProcess(command) {
  if (/\/Applications\/Codex\.app\/Contents\/MacOS\/Codex(?:\s|$)/.test(command)) {
    return { kind: "desktop", label: "Codex Desktop" };
  }

  if (/\/Applications\/Codex\.app\/Contents\/Resources\/codex app-server/.test(command)) {
    return { kind: "desktop-app-server", label: "Codex Desktop app-server" };
  }

  if (/\.vscode\/extensions\/.*\/codex app-server/.test(command)) {
    return { kind: "vscode-app-server", label: "VS Code Codex app-server" };
  }

  if (/Visual Studio Code\.app/.test(command) || /Code Helper/.test(command)) {
    return { kind: "vscode-helper", label: "VS Code Helper" };
  }

  if (/(^|\/)codex(\s|$)/.test(command) && !/codex-switch/.test(command) && !/app-server/.test(command)) {
    return { kind: "cli", label: "Codex CLI" };
  }

  const short = command.split(/\s+/)[0]?.split("/").pop() || "Other process";
  return { kind: "other", label: `${short} using ~/.codex` };
}

async function listCodexProcesses() {
  try {
    let lsofStdout = "";
    try {
      const result = await execFileAsync("lsof", ["+D", ACTIVE_CODEX_DIR]);
      lsofStdout = result.stdout || "";
    } catch (error) {
      lsofStdout = String(error.stdout || "");
    }

    const pidsTouchingCodexDir = new Set(
      lsofStdout
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const columns = line.split(/\s+/);
          return Number(columns[1]);
        })
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    );

    if (pidsTouchingCodexDir.size === 0) {
      return [];
    }

    const { stdout } = await execFileAsync("ps", ["ax", "-o", "pid=,command="]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) {
          return null;
        }

        const pid = Number(match[1]);
        const command = match[2];
        if (pid === process.pid) {
          return null;
        }

        if (!pidsTouchingCodexDir.has(pid)) {
          return null;
        }

        const classification = classifyCodexProcess(command);
        if (!classification) {
          return null;
        }

        return {
          pid,
          command,
          kind: classification.kind,
          label: classification.label
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function closeCodexProcesses() {
  const before = await listCodexProcesses();
  const actions = [];

  const hasDesktop = before.some((processInfo) => ["desktop", "desktop-app-server"].includes(processInfo.kind));
  if (hasDesktop) {
    try {
      await execFileAsync("osascript", ["-e", 'tell application "Codex" to quit']);
      actions.push("quit-desktop");
    } catch {}
  }

  const hasVSCode = before.some((processInfo) => ["vscode-helper", "vscode-app-server"].includes(processInfo.kind));
  if (hasVSCode) {
    const quitScripts = [
      'tell application id "com.microsoft.VSCode" to quit',
      'tell application "Visual Studio Code" to quit'
    ];
    for (const script of quitScripts) {
      try {
        await execFileAsync("osascript", ["-e", script]);
        actions.push("quit-vscode");
        break;
      } catch {}
    }
  }

  const pkillPatterns = [
    { pattern: "/Applications/Codex.app/Contents/Resources/codex app-server", action: "kill-desktop-app-server" },
    { pattern: "\\.vscode/extensions/.*/codex app-server", action: "kill-vscode-app-server" },
    { pattern: "Visual Studio Code\\.app/Contents/MacOS/Electron", action: "kill-vscode-main" },
    { pattern: "(^|/)codex( |$)", action: "kill-codex-cli" }
  ];

  for (const entry of pkillPatterns) {
    try {
      await execFileAsync("pkill", ["-f", entry.pattern]);
      actions.push(entry.action);
    } catch {}
  }

  let remaining = await listCodexProcesses();
  for (const processInfo of remaining) {
    try {
      await execFileAsync("kill", ["-TERM", String(processInfo.pid)]);
      actions.push(`kill-pid-${processInfo.pid}`);
    } catch {}
  }

  for (let attempt = 0; attempt < PROCESS_POLL_ATTEMPTS; attempt += 1) {
    await sleep(PROCESS_POLL_DELAY_MS);
    remaining = await listCodexProcesses();
    if (remaining.length === 0) {
      break;
    }
  }

  return {
    ok: remaining.length === 0,
    actions,
    before,
    remaining
  };
}

function sanitizePublicMessage(result) {
  return result.stderr || result.stdout || result.message || "Command failed";
}

async function resetCodexDesktopCaches() {
  if (!await pathExists(CODEX_APP_SUPPORT_DIR)) {
    return { ok: true, moved: [] };
  }

  const backupRoot = path.join(
    CODEX_APP_SUPPORT_DIR,
    `.switch-cache-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );
  const moved = [];

  for (const itemName of CODEX_CACHE_RESET_ITEMS) {
    const sourcePath = path.join(CODEX_APP_SUPPORT_DIR, itemName);
    if (!await pathExists(sourcePath)) {
      continue;
    }

    await ensureDir(backupRoot);
    const targetPath = path.join(backupRoot, itemName);
    await ensureParentDir(targetPath);
    await fsp.rename(sourcePath, targetPath);
    moved.push(itemName);
  }

  return {
    ok: true,
    backupRoot: moved.length > 0 ? backupRoot : null,
    moved
  };
}

async function rebuildCodexSidebar() {
  const processes = await listCodexProcesses();
  let closeResult = null;
  if (processes.length > 0) {
    closeResult = await closeCodexProcesses();
    if (!closeResult.ok) {
      return {
        ok: false,
        message: "Failed to close Codex-related processes before rebuilding sidebar",
        closeResult
      };
    }
  }

  await ensureSharedSessionsLayout();
  let recencyRepairResult = null;
  try {
    recencyRepairResult = await promoteSharedThreadRecencyForSidebar();
  } catch (error) {
    return {
      ok: false,
      message: error.message || "Failed to refresh shared thread recency for sidebar",
      closeResult
    };
  }

  let cacheResetResult = null;
  try {
    cacheResetResult = await resetCodexDesktopCaches();
  } catch (error) {
    return {
      ok: false,
      message: error.message || "Failed to reset Codex desktop caches",
      closeResult
    };
  }

  for (const { baseName } of SQLITE_SESSION_DATABASES) {
    await checkpointSqliteIfNeeded(path.join(SHARED_SESSIONS_DIR, baseName));
  }

  const openResult = await openMacTarget(["-a", "Codex"]);
  if (!openResult.ok) {
    return {
      ok: false,
      message: openResult.message || "Failed to reopen Codex",
      closeResult,
      cacheResetResult,
      openedCodex: false
    };
  }

  return {
    ok: true,
    message: cacheResetResult?.moved?.length
      ? "已重建 Codex 侧边栏缓存并重新打开 Codex"
      : "已重新打开 Codex，并按共享会话状态重建侧边栏",
    closeResult,
    recencyRepairResult,
    cacheResetResult,
    openedCodex: true
  };
}

async function performProfileSwitch(targetName, options = {}) {
  const closeAndForce = options.closeAndForce === true;
  const openCodex = options.openCodex === true;

  let closeResult = null;
  if (closeAndForce) {
    const processes = await listCodexProcesses();
    if (processes.length > 0) {
      closeResult = await closeCodexProcesses();
      if (!closeResult.ok) {
        return {
          ok: false,
          message: "Failed to close Codex-related processes before switching profiles",
          openedCodex: false,
          activeProfile: await readCurrentProfile(),
          forced: false,
          closeResult
        };
      }
    }
  }

  await ensureSharedSessionsLayout(targetName);
  let result = await runCodexSwitch(["use", targetName]);
  let forced = false;
  const firstMessage = sanitizePublicMessage(result);
  if (!result.ok && closeAndForce && /Codex appears to be running/i.test(firstMessage)) {
    closeResult = await closeCodexProcesses();
    if (closeResult.ok) {
      result = await runCodexSwitch(["--force", "use", targetName]);
      forced = true;
    }
  }

  let activeProfile = await readCurrentProfile();
  if (result.ok) {
    activeProfile = await waitForActiveProfile(targetName);
  }

  if (result.ok && activeProfile !== targetName && closeAndForce && !forced) {
    closeResult = closeResult || await closeCodexProcesses();
    result = await runCodexSwitch(["--force", "use", targetName]);
    forced = true;
    if (result.ok) {
      activeProfile = await waitForActiveProfile(targetName);
    }
  }

  if (result.ok && activeProfile !== targetName) {
    result = {
      ok: false,
      stdout: "",
      stderr: `Switch did not take effect. Active profile is still ${activeProfile}.`,
      message: "Switch did not take effect"
    };
  }

  let recencyRepairResult = null;
  if (result.ok && activeProfile === targetName) {
    await ensureSharedSessionsLayout(targetName);
    try {
      recencyRepairResult = await promoteSharedThreadRecencyForSidebar();
    } catch (error) {
      recencyRepairResult = {
        ok: false,
        error: error.message || "Failed to refresh shared thread recency for sidebar"
      };
    }
  }

  let cacheResetResult = null;
  if (result.ok && activeProfile === targetName && closeAndForce) {
    try {
      cacheResetResult = await resetCodexDesktopCaches();
    } catch (error) {
      cacheResetResult = {
        ok: false,
        error: error.message || "Failed to reset Codex desktop caches"
      };
    }
  }

  // Checkpoint all shared SQLite databases before reopening Codex
  // so the app sees fully-committed data instead of stale WAL entries
  if (result.ok && activeProfile === targetName) {
    for (const { baseName } of SQLITE_SESSION_DATABASES) {
      await checkpointSqliteIfNeeded(path.join(SHARED_SESSIONS_DIR, baseName));
    }
  }

  let openResult = null;
  if (result.ok && openCodex) {
    openResult = await openMacTarget(["-a", "Codex"]);
  }

  return {
    ok: result.ok,
    message: sanitizePublicMessage(result),
    openedCodex: openResult?.ok === true,
    activeProfile,
    forced,
    closeResult,
    recencyRepairResult,
    cacheResetResult
  };
}

function pickAutoSwitchTarget(state) {
  return state.profiles.find((profile) => profile.profileName !== state.activeProfile && profile.priority?.usable) || null;
}

async function runAutoSwitchCheck() {
  const now = Date.now();
  autoSwitchRuntime.lastCheckAt = new Date(now).toISOString();

  if (!autoSwitchRuntime.enabled) {
    setAutoSwitchDecision("自动切号未启用");
    return;
  }

  if (autoSwitchRuntime.inFlight) {
    setAutoSwitchDecision("自动切号正在执行中");
    return;
  }

  if (autoSwitchRuntime.lastActionAt) {
    const lastActionAtMs = Date.parse(autoSwitchRuntime.lastActionAt);
    if (Number.isFinite(lastActionAtMs) && now - lastActionAtMs < AUTO_SWITCH_COOLDOWN_MS) {
      setAutoSwitchDecision("自动切号冷却中");
      return;
    }
  }

  autoSwitchRuntime.inFlight = true;
  try {
    const state = await getProfilesState();
    if (!isManagedProfileName(state.activeProfile)) {
      setAutoSwitchDecision("当前活动账号不在受管 profile 内，跳过自动切号");
      return;
    }

    if (!isUsageExhausted(state.activeUsage)) {
      setAutoSwitchDecision("当前账号额度仍可用，无需自动切号", {
        activeProfile: state.activeProfile
      });
      return;
    }

    const target = pickAutoSwitchTarget(state);
    if (!target) {
      setAutoSwitchDecision("当前账号额度已用尽，但没有可切换的备用账号", {
        activeProfile: state.activeProfile
      });
      return;
    }

    const switchResult = await performProfileSwitch(target.profileName, {
      closeAndForce: true,
      openCodex: true
    });

    autoSwitchRuntime.lastActionAt = new Date().toISOString();
    autoSwitchRuntime.lastAction = {
      fromProfile: state.activeProfile,
      toProfile: target.profileName,
      ok: switchResult.ok,
      message: switchResult.message,
      openedCodex: switchResult.openedCodex === true,
      at: autoSwitchRuntime.lastActionAt
    };

    if (!switchResult.ok) {
      autoSwitchRuntime.lastError = `自动切号失败: ${switchResult.message}`;
      setAutoSwitchDecision("当前账号额度已用尽，但自动切号失败", {
        activeProfile: state.activeProfile,
        targetProfile: target.profileName
      });
      return;
    }

    autoSwitchRuntime.lastError = null;
    setAutoSwitchDecision(`当前账号额度已用尽，已自动切换到 ${target.profileName}`, {
      activeProfile: target.profileName
    });
  } catch (error) {
    autoSwitchRuntime.lastError = error.message || "Auto switch failed";
    setAutoSwitchDecision("自动切号检查失败");
  } finally {
    autoSwitchRuntime.inFlight = false;
  }
}

async function initializeAutoSwitch() {
  const config = await readAutoSwitchConfig();
  autoSwitchRuntime.enabled = config.enabled;
  setInterval(() => {
    runAutoSwitchCheck().catch(() => {});
  }, AUTO_SWITCH_POLL_MS);
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      host: HOST,
      port: PORT
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/app/version") {
    const versionState = await getAppVersionState({ forceRefresh: false });
    sendJson(res, 200, {
      ok: true,
      app: versionState
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/app/update/check") {
    const versionState = await getAppVersionState({ forceRefresh: true });
    sendJson(res, 200, {
      ok: true,
      app: versionState
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/app/update/install") {
    const result = await scheduleAppUpdateInstall();
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    const state = await getProfilesState();
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "GET" && pathname === "/api/sessions") {
    const sessionBrowser = await readSessionBrowserState();
    sendJson(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      ...sessionBrowser
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/profile/save") {
    const body = await parseBody(req);
    if (!isValidProfileName(body.name)) {
      sendJson(res, 400, { ok: false, error: "Invalid profile name" });
      return;
    }
    const result = await runCodexSwitch(["save", body.name]);
    if (result.ok) {
      await ensureSharedSessionsLayout(body.name);
    }
    sendJson(res, result.ok ? 200 : 400, {
      ok: result.ok,
      message: sanitizePublicMessage(result)
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/profile/new") {
    const body = await parseBody(req);
    if (!isValidProfileName(body.name)) {
      sendJson(res, 400, { ok: false, error: "Invalid profile name" });
      return;
    }
    const result = await runCodexSwitch(["new", body.name]);
    if (result.ok) {
      await ensureSharedSessionsLayout(body.name);
    }
    sendJson(res, result.ok ? 200 : 400, {
      ok: result.ok,
      message: sanitizePublicMessage(result)
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/profile/use") {
    const body = await parseBody(req);
    if (!isValidProfileName(body.name)) {
      sendJson(res, 400, { ok: false, error: "Invalid profile name" });
      return;
    }
    const result = await performProfileSwitch(body.name, {
      closeAndForce: body.closeAndForce === true,
      openCodex: body.openCodex === true
    });
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/repair") {
    const body = await parseBody(req);
    const processes = await listCodexProcesses();
    if (processes.length > 0) {
      sendJson(res, 409, {
        ok: false,
        error: "Codex appears to be running. Close Codex-related processes before repairing sessions.",
        processes
      });
      return;
    }

    await ensureSharedSessionsLayout();
    let openResult = null;
    if (body.openCodex === true) {
      openResult = await openMacTarget(["-a", "Codex"]);
    }
    sendJson(res, 200, {
      ok: true,
      message: `Merged local session history into ${SHARED_SESSIONS_DIR}`,
      openedCodex: openResult?.ok === true
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/codex/processes") {
    const processes = await listCodexProcesses();
    sendJson(res, 200, {
      ok: true,
      processes,
      hasBlockingProcesses: processes.length > 0
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/codex/close") {
    const result = await closeCodexProcesses();
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/codex/rebuild-sidebar") {
    const result = await rebuildCodexSidebar();
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }

  if (req.method === "GET" && pathname === "/api/auto-switch") {
    sendJson(res, 200, {
      ok: true,
      autoSwitch: getAutoSwitchPublicState()
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/auto-switch") {
    const body = await parseBody(req);
    if (typeof body.enabled !== "boolean") {
      sendJson(res, 400, { ok: false, error: "enabled must be boolean" });
      return;
    }

    const autoSwitch = await setAutoSwitchEnabled(body.enabled);
    if (autoSwitch.enabled) {
      runAutoSwitchCheck().catch(() => {});
    }

    sendJson(res, 200, {
      ok: true,
      autoSwitch
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/profile/rename") {
    const body = await parseBody(req);
    if (!isValidProfileName(body.oldName) || !isValidProfileName(body.newName)) {
      sendJson(res, 400, { ok: false, error: "Invalid profile name" });
      return;
    }
    const result = await renameProfile(body.oldName, body.newName);
    if (result.ok) {
      await ensureSharedSessionsLayout(body.newName);
    }
    sendJson(res, result.ok ? 200 : 400, {
      ok: result.ok,
      message: sanitizePublicMessage(result)
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/profile/delete") {
    const body = await parseBody(req);
    if (!isValidProfileName(body.name)) {
      sendJson(res, 400, { ok: false, error: "Invalid profile name" });
      return;
    }
    const result = await deleteProfile(body.name);
    sendJson(res, result.ok ? 200 : 400, {
      ok: result.ok,
      message: sanitizePublicMessage(result)
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/profile/auto-register-active") {
    const result = await autoRegisterActiveProfile();
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/resume") {
    const body = await parseBody(req);
    const session = await findSharedSessionById(body.id);
    if (!session) {
      sendJson(res, 404, { ok: false, error: "Session not found" });
      return;
    }

    const commandParts = [];
    if (session.cwd) {
      commandParts.push(`cd ${shellQuote(session.cwd)}`);
    }
    commandParts.push(`codex resume --all ${shellQuote(session.id)}`);
    const result = await openTerminalCommand(commandParts.join(" && "));
    sendJson(res, result.ok ? 200 : 500, {
      ok: result.ok,
      message: result.ok
        ? `已在 Terminal 打开会话：${session.title || session.id}`
        : result.message
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/delete") {
    const body = await parseBody(req);
    const sessionId = typeof body.id === "string" ? body.id.trim() : "";
    if (!sessionId) {
      sendJson(res, 400, { ok: false, error: "Invalid session id" });
      return;
    }

    const result = await deleteSharedSessionById(sessionId);
    if (!result.ok) {
      const status = result.notFound ? 404 : 400;
      sendJson(res, status, {
        ok: false,
        error: result.error || "Failed to delete session"
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      deletedId: result.id,
      deletedFiles: result.deletedFiles,
      wroteSessionIndex: result.wroteSessionIndex,
      wroteGlobalState: result.wroteGlobalState,
      message: `已物理删除会话：${result.title}（清理 ${result.deletedFiles} 个本地文件）`
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/reveal") {
    const body = await parseBody(req);
    const session = await findSharedSessionById(body.id);
    if (!session) {
      sendJson(res, 404, { ok: false, error: "Session not found" });
      return;
    }

    const rolloutPath = typeof session.rolloutPath === "string" ? session.rolloutPath.trim() : "";
    const cwdPath = typeof session.cwd === "string" ? session.cwd.trim() : "";
    let targetPath = "";
    let revealMode = false;

    if (rolloutPath && isHomeRelativePath(rolloutPath) && await pathExists(rolloutPath)) {
      targetPath = rolloutPath;
      revealMode = true;
    } else if (cwdPath && isHomeRelativePath(cwdPath) && await pathExists(cwdPath)) {
      targetPath = cwdPath;
    }

    if (!targetPath) {
      sendJson(res, 400, { ok: false, error: "No local file path found for this session" });
      return;
    }

    const result = await openMacTarget(revealMode ? ["-R", targetPath] : [targetPath]);
    sendJson(res, result.ok ? 200 : 500, {
      ok: result.ok,
      message: result.ok
        ? (revealMode ? "已在 Finder 中定位到会话文件" : "已打开会话目录")
        : result.message
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/open/codex") {
    const result = await openMacTarget(["-a", "Codex"]);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/login/start") {
    const prepared = await prepareProfileForLogin();
    if (!prepared.ok) {
      sendJson(res, 400, {
        ok: false,
        message: prepared.message || "Failed to prepare a staging profile for login"
      });
      return;
    }

    const result = await openTerminalCommand("codex login");
    sendJson(res, result.ok ? 200 : 500, {
      ok: result.ok,
      message: result.ok
        ? (prepared.changed
            ? `已切到临时登录 profile ${prepared.stagingProfile}，请在终端里完成 codex login`
            : "已打开 Terminal，请在终端里完成 codex login")
        : result.message
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/login/start-device-auth") {
    const prepared = await prepareProfileForLogin();
    if (!prepared.ok) {
      sendJson(res, 400, {
        ok: false,
        message: prepared.message || "Failed to prepare a staging profile for device auth"
      });
      return;
    }

    const result = await openTerminalCommand("codex login --device-auth");
    sendJson(res, result.ok ? 200 : 500, {
      ok: result.ok,
      message: result.ok
        ? (prepared.changed
            ? `已切到临时登录 profile ${prepared.stagingProfile}，请按设备码流程登录`
            : "已打开 Terminal，请按设备码流程登录")
        : result.message
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/login/logout") {
    const { stdout, stderr } = await execFileAsync("codex", ["logout"]);
    sendJson(res, 200, {
      ok: true,
      message: String(stdout || stderr || "Logged out").trim() || "Logged out"
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/open/profiles") {
    const result = await openMacTarget([PROFILES_DIR]);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
}

async function serveStatic(res, pathname) {
  let targetPath = pathname === "/" ? "/index.html" : pathname;
  targetPath = path.normalize(targetPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, targetPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath);
    const type =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
      ext === ".js" ? "application/javascript; charset=utf-8" :
      "application/octet-stream";
    sendText(res, 200, data, type);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(res, 404, "Not found");
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error.message
    });
  }
});

let autoSwitchInitialized = false;
let serverStartPromise = null;

async function startServer() {
  if (server.listening) {
    return server;
  }

  if (serverStartPromise) {
    return serverStartPromise;
  }

  serverStartPromise = (async () => {
    if (!autoSwitchInitialized) {
      autoSwitchInitialized = true;
      try {
        await initializeAutoSwitch();
      } catch (error) {
        console.error("Failed to initialize auto switch:", error);
      }
    }

    await new Promise((resolve, reject) => {
      const handleError = (error) => {
        server.off("listening", handleListening);
        reject(error);
      };
      const handleListening = () => {
        server.off("error", handleError);
        resolve();
      };

      server.once("error", handleError);
      server.once("listening", handleListening);
      server.listen(PORT, HOST);
    });

    console.log(`Codex Switch Web running at http://${HOST}:${PORT}`);
    return server;
  })();

  try {
    return await serverStartPromise;
  } catch (error) {
    serverStartPromise = null;
    throw error;
  }
}

async function stopServer() {
  if (!server.listening) {
    serverStartPromise = null;
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  serverStartPromise = null;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to start Codex Switch Web:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  HOST,
  PORT,
  startServer,
  stopServer
};
