const activeProfileEl = document.querySelector("#activeProfile");
const profilesDirEl = document.querySelector("#profilesDir");
const profilesGridEl = document.querySelector("#profilesGrid");
const toastEl = document.querySelector("#toast");
const profileTemplate = document.querySelector("#profileTemplate");
const loginStatusEl = document.querySelector("#loginStatus");
const activeAccountEmailEl = document.querySelector("#activeAccountEmail");
const activeUsageTitleEl = document.querySelector("#activeUsageTitle");
const activeUsageMeterBarEl = document.querySelector("#activeUsageMeterBar");
const autoSwitchTitleEl = document.querySelector("#autoSwitchTitle");
const autoSwitchMetaEl = document.querySelector("#autoSwitchMeta");
const autoSwitchToggleButtonEl = document.querySelector("#autoSwitchToggleButton");
const appVersionChipEl = document.querySelector("#appVersionChip");
const appUpdateStatusEl = document.querySelector("#appUpdateStatus");
const checkUpdateButtonEl = document.querySelector("#checkUpdateButton");
const installUpdateButtonEl = document.querySelector("#installUpdateButton");
const rebuildSidebarButtonEl = document.querySelector("#rebuildSidebarButton");
const usageNoticeEl = document.querySelector("#usageNotice");
const usageNoticeTextEl = document.querySelector("#usageNoticeText");
const usageNoticeCloseEl = document.querySelector("#usageNoticeClose");
const sessionsSummaryEl = document.querySelector("#sessionsSummary");
const sessionProjectsListEl = document.querySelector("#sessionProjectsList");
const refreshSessionsButtonEl = document.querySelector("#refreshSessionsButton");
const sessionSearchInputEl = document.querySelector("#sessionSearchInput");
let autoRegisterInFlight = false;
let versionLoadInFlight = false;
let appVersionState = null;
let sessionsLoadInFlight = false;
let sessionBrowserState = null;
let lastSeenActiveProfile = null;
const expandedProfiles = new Set();
const expandedSessionProjects = new Set();
const usageRenderCache = new Map();
let dismissedUsageNoticeKey = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || data.message || "Request failed");
  }
  return data;
}

function showToast(message, tone = "info") {
  toastEl.textContent = message;
  toastEl.className = `toast ${tone}`;
  setTimeout(() => { toastEl.className = "toast hidden"; }, 2800);
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatLoginStatus(value) {
  if (!value) return "-";
  const text = String(value).trim();
  if (/^Logged in using ChatGPT$/i.test(text)) return "ChatGPT 登录";
  if (/^Logged in using API key$/i.test(text)) return "API Key 登录";
  if (/logged out/i.test(text)) return "未登录";
  return text;
}

function formatShortPath(value) {
  if (!value) return "-";
  return value.replace("/Users/mac", "~");
}

function formatDurationMinutes(ms) {
  if (!Number.isFinite(ms)) return "未知";
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.round(totalMinutes / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getUsageTone(percent) {
  if (percent <= 10) return "danger";
  if (percent <= 35) return "warn";
  return "good";
}

function getUsageStatusLabel(percent) {
  if (percent <= 0) return "已耗尽";
  if (percent <= 10) return "非常低";
  if (percent <= 35) return "偏低";
  if (percent <= 70) return "正常";
  return "充足";
}

function formatResetLabel(value) {
  return value ? `重置 ${formatTime(value)}` : "重置时间未知";
}

function getUsageIssueText(usage) {
  if (!usage) return null;
  if (usage.fallback === true) {
    return usage.issue?.message || "当前网络异常，正在显示上次成功数据";
  }
  return usage.issue?.message || null;
}

function hasRenderableUsage(usage) {
  return Boolean(usage && usage.ok !== false && usage.data?.summary && usage.data.summary.remainingPercent != null);
}

function cloneUsageForDisplay(usage, issueText) {
  if (!hasRenderableUsage(usage)) return null;
  return {
    ok: true,
    data: usage.data,
    rawFetchedAt: usage.rawFetchedAt || null,
    fallback: true,
    issue: {
      level: "warn",
      message: issueText || "当前读取失败，正在显示上次成功数据"
    }
  };
}

function getDisplayUsage(cacheKey, usage) {
  if (hasRenderableUsage(usage)) {
    if (usage.fallback !== true) {
      usageRenderCache.set(cacheKey, {
        ok: true,
        data: usage.data,
        rawFetchedAt: usage.rawFetchedAt || null
      });
    }
    return usage;
  }

  const cached = usageRenderCache.get(cacheKey);
  return cloneUsageForDisplay(cached, getUsageIssueText(usage) || usage?.error) || usage;
}

function renderVersionState(appState) {
  appVersionState = appState;
  appVersionChipEl.textContent = appState?.currentVersionLabel || "v-";

  const update = appState?.update;
  const install = appState?.install;
  let statusText = "未检查更新";
  if (appState?.packaged === false) {
    statusText = "源码模式";
  }
  if (install?.inFlight) {
    statusText = install.message || "正在后台安装更新";
  } else if (install?.phase === "failed" && install?.error) {
    statusText = install.error;
  } else if (update?.ok === false) {
    statusText = update.error || "检查更新失败";
  } else if (update?.available) {
    statusText = `发现 ${update.latestVersionLabel}`;
  } else if (update?.latestVersion && update.latestVersion === appState?.currentVersion) {
    statusText = "已是最新版本";
  } else if (update?.latestVersion) {
    statusText = `当前高于已发布版 ${update.latestVersionLabel}`;
  }
  appUpdateStatusEl.textContent = statusText;

  const showInstall = Boolean(appState?.packaged && update?.available && !install?.inFlight);
  installUpdateButtonEl.classList.toggle("hidden", !showInstall);
  if (showInstall) {
    installUpdateButtonEl.textContent = `安装 ${update.latestVersionLabel}`;
  }
  installUpdateButtonEl.disabled = Boolean(install?.inFlight);
}

async function loadVersionState({ force = false } = {}) {
  if (versionLoadInFlight) return appVersionState;
  versionLoadInFlight = true;
  checkUpdateButtonEl.disabled = true;
  installUpdateButtonEl.disabled = true;
  try {
    const result = await api(force ? "/api/app/update/check" : "/api/app/version", {
      method: force ? "POST" : "GET"
    });
    renderVersionState(result.app);
    return result.app;
  } catch (error) {
    appUpdateStatusEl.textContent = error.message;
    throw error;
  } finally {
    versionLoadInFlight = false;
    checkUpdateButtonEl.disabled = false;
    installUpdateButtonEl.disabled = false;
  }
}

function createUsageEntry(windowInfo, fallbackLabel) {
  if (!windowInfo || windowInfo.remainingPercent == null) return null;
  const percent = clampPercent(windowInfo.remainingPercent);
  return {
    label: fallbackLabel || windowInfo.label || "额度",
    percent,
    usedPercent: clampPercent(windowInfo.usedPercent ?? (100 - percent)),
    tone: getUsageTone(percent),
    status: getUsageStatusLabel(percent),
    detail: formatResetLabel(windowInfo.resetAt)
  };
}

function getUsageEntries(usage) {
  if (!usage || usage.ok === false || !usage.data) return [];
  const data = usage.data;
  const entries = [];
  const seen = new Set();

  for (const windowInfo of [data.primary, data.secondary]) {
    const entry = createUsageEntry(windowInfo);
    if (!entry) continue;
    const key = `${entry.label}:${entry.percent}:${entry.detail}`;
    if (!seen.has(key)) { seen.add(key); entries.push(entry); }
  }

  const reviewEntry = createUsageEntry(data.codeReview, "Code Review");
  if (reviewEntry) {
    const key = `${reviewEntry.label}:${reviewEntry.percent}:${reviewEntry.detail}`;
    if (!seen.has(key)) { seen.add(key); entries.push(reviewEntry); }
  }

  for (const limit of data.additionalLimits || []) {
    for (const windowInfo of [limit.primary, limit.secondary]) {
      const entry = createUsageEntry(windowInfo, limit.label || undefined);
      if (!entry) continue;
      const key = `${entry.label}:${entry.percent}:${entry.detail}`;
      if (!seen.has(key)) { seen.add(key); entries.push(entry); }
    }
  }
  return entries;
}

function getCreditSummary(usage) {
  if (!usage || usage.ok === false || !usage.data?.credits) return null;
  const credits = usage.data.credits;
  if (credits.unlimited) return { label: "Credit", value: "无限", detail: "额外 credit 不受限" };
  if (!credits.hasCredits) return null;
  return {
    label: "Credit",
    value: credits.balance == null ? "可用" : `${Math.floor(credits.balance)} credit`,
    detail: "购买的 credit 可在主额度用完后继续使用"
  };
}

function getUsageSummary(usage) {
  if (!usage) return { title: "未查询额度", meta: "还没有拿到额度数据", percent: null, tone: "warn" };
  if (usage.ok === false) return { title: "额度异常", meta: usage.error || "查询失败", percent: null, tone: "danger" };
  const data = usage.data;
  if (!data || !data.summary || data.summary.remainingPercent == null) {
    return { title: "额度异常", meta: "当前账号未返回额度信息", percent: null, tone: "warn" };
  }
  const percent = clampPercent(data.summary.remainingPercent);
  const blocked = data.blocked === true || data.summary.blocked === true || percent <= 0;
  return {
    title: `${blocked ? "当前不可用" : getUsageStatusLabel(percent)} · ${percent}%`,
    meta: [data.summary.label, formatResetLabel(data.summary.resetAt), data.summary.note].filter(Boolean).join(" · "),
    percent,
    tone: blocked ? "danger" : getUsageTone(percent)
  };
}

function getUsageNoticeKey(activeProfile, usage) {
  const startedAt = usage?.issue?.startedAt;
  if (!activeProfile || !startedAt) return null;
  return `${activeProfile}:${startedAt}`;
}

function renderUsageNotice(activeProfile, usage) {
  const issue = usage?.issue;
  const noticeKey = getUsageNoticeKey(activeProfile, usage);
  if (!issue?.showNotice || !noticeKey || dismissedUsageNoticeKey === noticeKey) {
    usageNoticeEl.classList.add("hidden");
    usageNoticeTextEl.textContent = "";
    usageNoticeCloseEl.dataset.noticeKey = "";
    return;
  }

  usageNoticeTextEl.textContent = hasRenderableUsage(usage)
    ? "额度已连续 5 分钟读取失败，当前继续显示上次成功结果。"
    : "额度已连续 5 分钟读取失败，请检查网络或重新登录。";
  usageNoticeCloseEl.dataset.noticeKey = noticeKey;
  usageNoticeEl.classList.remove("hidden");
}

function renderUsageBox(node, usage, cacheKey) {
  const titleEl = node.querySelector(".usage-title");
  const noteEl = node.querySelector(".usage-note");
  const badgeEl = node.querySelector(".usage-badge");
  const linesEl = node.querySelector(".usage-lines");
  const displayUsage = getDisplayUsage(cacheKey, usage);
  const summary = getUsageSummary(displayUsage);
  const entries = getUsageEntries(displayUsage);
  const credit = getCreditSummary(displayUsage);

  titleEl.textContent = summary.title;
  noteEl.textContent = summary.meta;
  badgeEl.textContent = summary.percent == null ? "--" : `${summary.percent}%`;
  badgeEl.dataset.tone = summary.tone;
  linesEl.innerHTML = "";

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "usage-meter";
    row.dataset.tone = entry.tone;

    const head = document.createElement("div");
    head.className = "usage-meter-head";
    const labelGroup = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = entry.label;
    labelGroup.appendChild(label);
    const detail = document.createElement("div");
    detail.className = "usage-meter-detail";
    detail.textContent = entry.detail;
    labelGroup.appendChild(detail);
    head.appendChild(labelGroup);
    const value = document.createElement("span");
    value.className = "usage-meter-value";
    value.textContent = `${entry.percent}% 剩余`;
    head.appendChild(value);
    row.appendChild(head);

    const track = document.createElement("div");
    track.className = "usage-meter-track";
    const fill = document.createElement("div");
    fill.className = "usage-meter-fill";
    fill.style.width = `${entry.percent}%`;
    track.appendChild(fill);
    row.appendChild(track);

    const footer = document.createElement("div");
    footer.className = "usage-meter-foot";
    const status = document.createElement("span");
    status.textContent = entry.status;
    footer.appendChild(status);
    const used = document.createElement("span");
    used.textContent = `已使用 ${entry.usedPercent}%`;
    footer.appendChild(used);
    row.appendChild(footer);
    linesEl.appendChild(row);
  }

  if (credit) {
    const creditRow = document.createElement("div");
    creditRow.className = "usage-credit";
    creditRow.innerHTML = `
      <strong>${credit.label}</strong>
      <span>${credit.value}</span>
      <small>${credit.detail}</small>
    `;
    linesEl.appendChild(creditRow);
  }
}

function renderStripUsage(node, usage, cacheKey) {
  const pctEl = node.querySelector(".strip-usage-pct");
  const fillEl = node.querySelector(".strip-usage-fill");
  const summary = getUsageSummary(getDisplayUsage(cacheKey, usage));

  pctEl.textContent = summary.percent == null ? "--" : `${summary.percent}%`;
  pctEl.dataset.tone = summary.tone;
  fillEl.style.width = `${summary.percent == null ? 0 : summary.percent}%`;
  fillEl.dataset.tone = summary.tone;
}

function getResetTimeShort(usage) {
  if (!usage || usage.ok === false || !usage.data) return null;
  const resetAt = usage.data.summary?.resetAt || usage.data.primary?.resetAt;
  if (!resetAt) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function renderStripReset(node, usage, cacheKey) {
  const labelEl = node.querySelector(".strip-reset-label");
  const resetTime = getResetTimeShort(getDisplayUsage(cacheKey, usage));
  if (resetTime) {
    labelEl.textContent = `重置 ${resetTime}`;
    labelEl.classList.remove("muted");
    labelEl.style.color = "";
  } else {
    labelEl.textContent = "重置时间未知";
  }
}

function renderAutoSwitch(status) {
  if (!status) {
    autoSwitchTitleEl.textContent = "自动切号未启用";
    autoSwitchMetaEl.textContent = "用尽后按优先级自动切换";
    autoSwitchToggleButtonEl.textContent = "开启";
    autoSwitchToggleButtonEl.dataset.mode = "off";
    return;
  }

  autoSwitchToggleButtonEl.textContent = status.enabled ? "关闭" : "开启";
  autoSwitchToggleButtonEl.dataset.mode = status.enabled ? "on" : "off";

  if (!status.enabled) {
    autoSwitchTitleEl.textContent = "自动切号未启用";
    autoSwitchMetaEl.textContent = "用尽后按优先级自动切换";
    return;
  }

  autoSwitchTitleEl.textContent = status.inFlight ? "正在检查..." : "自动切号已启用";

  const details = [];
  if (status.lastDecision?.summary) details.push(status.lastDecision.summary);
  if (status.lastAction?.fromProfile && status.lastAction?.toProfile) {
    details.push(`${status.lastAction.fromProfile} → ${status.lastAction.toProfile}`);
  }
  if (status.lastCheckAt) details.push(`上次 ${formatTime(status.lastCheckAt)}`);
  details.push(`间隔 ${formatDurationMinutes(status.pollIntervalMs)}`);
  autoSwitchMetaEl.textContent = details.join(" · ");
}

function getInitial(name) {
  if (!name) return "?";
  const cleaned = name.replace(/^pre-switch-.*$/, "");
  if (!cleaned) return "?";
  const first = cleaned.charAt(0).toUpperCase();
  return /[A-Z0-9]/.test(first) ? first : cleaned.charAt(0);
}

function renderProfiles(profiles) {
  profilesGridEl.innerHTML = "";
  const visibleProfiles = profiles.filter((p) => !/^pre-switch-\d{8}-\d{6}$/.test(p.profileName));

  if (!visibleProfiles.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有保存任何 profile。先完成一次登录，页面会自动保存当前账号。";
    profilesGridEl.appendChild(empty);
    return;
  }

  for (const [index, profile] of visibleProfiles.entries()) {
    const node = profileTemplate.content.firstElementChild.cloneNode(true);
    const planLabel = String(profile.planType || "-");
    const planTone = planLabel.trim().toLowerCase();

    // Strip bar info
    node.querySelector(".profile-name").textContent = profile.profileName;
    node.querySelector(".profile-email").textContent = profile.email || "未检测到邮箱";
    node.querySelector(".strip-avatar").textContent = getInitial(profile.profileName);
    const stripPlanEl = node.querySelector(".strip-plan");
    stripPlanEl.textContent = planLabel;
    stripPlanEl.dataset.plan = planTone;

    // Strip mini usage
    renderStripUsage(node, profile.usage, profile.profileName);

    // Detail facts
    node.querySelector(".fact-name").textContent = profile.displayName || "-";
    node.querySelector(".fact-auth-mode").textContent = profile.authMode || "-";
    node.querySelector(".fact-plan").textContent = planLabel;
    node.querySelector(".fact-refresh").textContent = formatTime(profile.lastRefresh);
    node.querySelector(".fact-path").textContent = formatShortPath(profile.path);

    // Reset time & usage box
    renderStripReset(node, profile.usage, profile.profileName);
    renderUsageBox(node, profile.usage, profile.profileName);

    // Active state
    const activeChip = node.querySelector(".strip-active-dot");
    const button = node.querySelector(".use-button");
    if (profile.active) {
      activeChip.classList.remove("hidden");
      node.classList.add("is-active");
      button.classList.add("hidden");
    }

    // Restore expanded state
    if (expandedProfiles.has(profile.profileName)) {
      node.classList.add("is-expanded");
    }

    // Expand/collapse toggle
    const stripBar = node.querySelector(".strip-bar");

    function toggleExpand(e) {
      if (e.target.closest(".use-button") || e.target.closest(".delete-button")) return;
      node.classList.toggle("is-expanded");
      if (node.classList.contains("is-expanded")) {
        expandedProfiles.add(profile.profileName);
      } else {
        expandedProfiles.delete(profile.profileName);
      }
    }

    stripBar.addEventListener("click", toggleExpand);

    // Switch button
    button.disabled = profile.active;
    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const ready = await ensureCodexReady("切换账号");
        if (!ready) return;
        const result = await api("/api/profile/use", {
          method: "POST",
          body: { name: profile.profileName, openCodex: true, closeAndForce: true }
        });
        const message = result.openedCodex
          ? `${result.message || "切换完成"}，已打开 Codex`
          : (result.message || "切换完成");
        showToast(message, "success");
        await loadState();
      } catch (error) {
        showToast(error.message, "error");
      }
    });

    // Delete button
    const deleteButton = node.querySelector(".delete-button");
    deleteButton.disabled = profile.active;
    deleteButton.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = window.confirm(`确定删除 profile "${profile.profileName}" 吗？`);
      if (!ok) return;
      try {
        const result = await api("/api/profile/delete", {
          method: "POST",
          body: { name: profile.profileName }
        });
        showToast(result.message || "已删除", "success");
        await loadState();
      } catch (error) {
        showToast(error.message, "error");
      }
    });

    profilesGridEl.appendChild(node);
  }
}

function getSessionProjectKey(project) {
  return project.workspaceRoot || project.label || "unknown";
}

function normalizeComparablePath(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function getProjectDesktopState(project) {
  const sessions = Array.isArray(project?.sessions) ? project.sessions : [];
  const latestSession = sessions.reduce((latest, session) => {
    if (!latest) {
      return session;
    }
    return String(session?.updatedAt || "").localeCompare(String(latest?.updatedAt || "")) > 0
      ? session
      : latest;
  }, null);

  const workspaceRoot = normalizeComparablePath(project?.workspaceRoot || "");
  const latestSessionCwd = normalizeComparablePath(latestSession?.cwd || "");
  const latestSessionInSubdir = Boolean(
    workspaceRoot &&
    latestSessionCwd &&
    latestSessionCwd !== workspaceRoot &&
    latestSessionCwd.startsWith(`${workspaceRoot}/`)
  );
  const latestSessionRootMismatch = Boolean(
    workspaceRoot &&
    latestSessionCwd &&
    latestSessionCwd !== workspaceRoot
  );

  return {
    latestSession,
    latestSessionCwd,
    latestSessionInSubdir,
    latestSessionRootMismatch
  };
}

function matchesSessionQuery(project, session, query) {
  if (!query) return true;
  const haystack = [
    project.label,
    project.workspaceRoot,
    session.title,
    session.cwd,
    session.id,
    session.rolloutPath
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function summarizeSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : []).reduce((summary, session) => {
    summary.totalCount += 1;
    if (session?.sidebarSeeded) {
      summary.recentCount += 1;
    } else {
      summary.outsideRecentCount += 1;
    }
    return summary;
  }, {
    totalCount: 0,
    recentCount: 0,
    outsideRecentCount: 0
  });
}

function buildSessionRow(session, projectDesktopState) {
  const isRecent = Boolean(session?.sidebarSeeded);
  const row = document.createElement("article");
  row.className = `session-row ${isRecent ? "session-row-visible" : "session-row-hidden"}`;

  const main = document.createElement("div");
  main.className = "session-row-main";

  const rowTitle = document.createElement("strong");
  rowTitle.className = "session-row-title";
  rowTitle.textContent = session.title || `会话 ${session.id}`;
  main.appendChild(rowTitle);

  const rowMeta = document.createElement("div");
  rowMeta.className = "session-row-meta";
  rowMeta.textContent = [
    formatTime(session.updatedAt),
    formatShortPath(session.cwd || session.workspaceRoot || ""),
    `来源 ${session.source || "未知"}`,
    session.sidebarSeeded ? "共享库前100" : "共享库100外",
    session.model ? `${session.modelProvider || "model"}:${session.model}` : null,
    projectDesktopState?.latestSessionInSubdir
      ? "桌面端可能归组异常（最新线程在子目录）"
      : projectDesktopState?.latestSessionRootMismatch
        ? "桌面端可能归组异常（最新线程路径与项目根不一致）"
        : null
  ].filter(Boolean).join(" · ");
  main.appendChild(rowMeta);

  const rowId = document.createElement("code");
  rowId.className = "session-row-id";
  rowId.textContent = session.id;
  main.appendChild(rowId);
  row.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "session-row-actions";

  const resumeButton = document.createElement("button");
  resumeButton.className = "btn btn-sm btn-primary";
  resumeButton.type = "button";
  resumeButton.textContent = "继续会话";
  resumeButton.addEventListener("click", async () => {
    resumeButton.disabled = true;
    try {
      const result = await api("/api/session/resume", {
        method: "POST",
        body: { id: session.id }
      });
      showToast(result.message || "已在 Terminal 打开会话", "success");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      resumeButton.disabled = false;
    }
  });
  actions.appendChild(resumeButton);

  const revealButton = document.createElement("button");
  revealButton.className = "btn btn-sm btn-secondary";
  revealButton.type = "button";
  revealButton.textContent = "定位文件";
  revealButton.addEventListener("click", async () => {
    revealButton.disabled = true;
    try {
      const result = await api("/api/session/reveal", {
        method: "POST",
        body: { id: session.id }
      });
      showToast(result.message || "已打开本地路径", "success");
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      revealButton.disabled = false;
    }
  });
  actions.appendChild(revealButton);

  const deleteButton = document.createElement("button");
  deleteButton.className = "btn btn-sm btn-delete";
  deleteButton.type = "button";
  deleteButton.textContent = "物理删除";
  deleteButton.addEventListener("click", async () => {
    const confirmed = window.confirm(
      `确定物理删除这个 session 吗？\n\n${session.title || `会话 ${session.id}`}\n${session.id}\n\n会删除数据库记录与本地会话文件，且不可恢复。`
    );
    if (!confirmed) {
      return;
    }

    resumeButton.disabled = true;
    revealButton.disabled = true;
    deleteButton.disabled = true;
    try {
      const result = await api("/api/session/delete", {
        method: "POST",
        body: { id: session.id }
      });
      showToast(result.message || "已物理删除会话", "success");
      await loadSessionBrowser();
    } catch (error) {
      showToast(error.message, "error");
      resumeButton.disabled = false;
      revealButton.disabled = false;
      deleteButton.disabled = false;
    }
  });
  actions.appendChild(deleteButton);

  row.appendChild(actions);
  return row;
}

function renderSessionProjects(browser) {
  if (!sessionProjectsListEl || !sessionsSummaryEl) {
    return;
  }

  sessionProjectsListEl.innerHTML = "";

  const allProjects = Array.isArray(browser?.projects) ? browser.projects : [];
  const analyzedProjects = allProjects.map((project) => ({
    ...project,
    projectDesktopState: getProjectDesktopState(project)
  }));
  const allSessions = analyzedProjects.flatMap((project) => Array.isArray(project.sessions) ? project.sessions : []);
  const overallSummary = summarizeSessions(allSessions);
  const overallRiskyProjectCount = analyzedProjects.filter(
    (project) => project.projectDesktopState?.latestSessionRootMismatch
  ).length;
  const query = (sessionSearchInputEl?.value || "").trim().toLowerCase();
  const projects = analyzedProjects
    .map((project) => ({
      ...project,
      sessionSummary: summarizeSessions(project.sessions),
      sessions: Array.isArray(project.sessions)
        ? project.sessions.filter((session) => matchesSessionQuery(project, session, query))
        : []
    }))
    .filter((project) => project.sessions.length > 0);

  const totalRenderedSessions = projects.reduce((sum, project) => sum + project.sessions.length, 0);
  if (browser?.summary) {
    const parts = [
      `全部 ${browser.summary.totalSessions} 个 session`,
      `项目 ${browser.summary.totalProjects} 个`,
      `共享库前100 ${Math.min(browser.summary.totalSessions, browser.summary.sidebarWindowSize)} 条`,
      `共享库100外 ${overallSummary.outsideRecentCount} 条`,
      `最新线程子目录异常 ${overallRiskyProjectCount} 个项目`,
      "下方按项目列出全部会话"
    ];
    if (query) {
      parts.push(`筛出 ${projects.length} 个项目 / ${totalRenderedSessions} 条会话`);
    }
    sessionsSummaryEl.textContent = parts.join(" · ");
  } else {
    sessionsSummaryEl.textContent = query
      ? `筛出 ${projects.length} 个项目 / ${totalRenderedSessions} 条会话`
      : "暂无会话数据";
  }

  if (!projects.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = query ? "没有匹配到会话。" : "还没有可展示的会话。";
    sessionProjectsListEl.appendChild(empty);
    return;
  }

  for (const project of projects) {
    const projectKey = getSessionProjectKey(project);
    const details = document.createElement("details");
    details.className = "session-project";
    details.open = expandedSessionProjects.has(projectKey) || (!query && project.sessionSummary.recentCount > 0);
    details.addEventListener("toggle", () => {
      if (details.open) {
        expandedSessionProjects.add(projectKey);
      } else {
        expandedSessionProjects.delete(projectKey);
      }
    });

    const summary = document.createElement("summary");
    summary.className = "session-project-summary";

    const heading = document.createElement("div");
    heading.className = "session-project-heading";
    const title = document.createElement("strong");
    title.className = "session-project-title";
    title.textContent = project.label || "未分组";
    heading.appendChild(title);
    const pathMeta = document.createElement("span");
    pathMeta.className = "session-project-path muted";
    pathMeta.textContent = formatShortPath(project.workspaceRoot || "");
    heading.appendChild(pathMeta);
    summary.appendChild(heading);

    const badges = document.createElement("div");
    badges.className = "session-project-badges";
    for (const text of [
      `全部 ${project.sessionSummary.totalCount}`,
      `共享前100 ${project.sessionSummary.recentCount}`,
      `共享100外 ${project.sessionSummary.outsideRecentCount}`,
      project.projectDesktopState?.latestSessionInSubdir
        ? "最新线程在子目录"
        : project.projectDesktopState?.latestSessionRootMismatch
          ? "最新线程路径异常"
          : "最新线程在项目根"
    ]) {
      const badge = document.createElement("span");
      badge.className = "session-badge";
      badge.textContent = text;
      badges.appendChild(badge);
    }
    summary.appendChild(badges);
    details.appendChild(summary);

    const list = document.createElement("div");
    list.className = "session-list";

    if (project.projectDesktopState?.latestSessionRootMismatch) {
      const risk = document.createElement("section");
      risk.className = "session-subgroup";

      const riskHead = document.createElement("div");
      riskHead.className = "session-subgroup-head";
      riskHead.dataset.tone = "hidden";

      const riskTitle = document.createElement("strong");
      riskTitle.className = "session-subgroup-title";
      riskTitle.textContent = "桌面端归组异常风险";
      riskHead.appendChild(riskTitle);
      risk.appendChild(riskHead);

      const riskBody = document.createElement("p");
      riskBody.className = "muted";
      riskBody.textContent = project.projectDesktopState.latestSessionInSubdir
        ? `这个项目最新线程的 cwd 是 ${formatShortPath(project.projectDesktopState.latestSessionCwd)}，位于项目根子目录内，不是项目根 ${formatShortPath(project.workspaceRoot || "")}。这类项目在 Codex App 里可能出现项目行存在，但组内显示 No threads。`
        : `这个项目最新线程的 cwd 是 ${formatShortPath(project.projectDesktopState.latestSessionCwd)}，与项目根 ${formatShortPath(project.workspaceRoot || "")} 不一致。Codex App 可能因此出现归组异常。`;
      risk.appendChild(riskBody);
      list.appendChild(risk);
    }

    const sessionGroups = [
      {
        tone: "visible",
        title: `共享库前100 (${project.sessionSummary.recentCount})`,
        sessions: project.sessions.filter((session) => session.sidebarSeeded)
      },
      {
        tone: "hidden",
        title: `共享库100外 (${project.sessionSummary.outsideRecentCount})`,
        sessions: project.sessions.filter((session) => !session.sidebarSeeded)
      }
    ].filter((group) => group.sessions.length > 0);

    for (const group of sessionGroups) {
      const section = document.createElement("section");
      section.className = "session-subgroup";

      const sectionHead = document.createElement("div");
      sectionHead.className = "session-subgroup-head";
      sectionHead.dataset.tone = group.tone;

      const sectionTitle = document.createElement("strong");
      sectionTitle.className = "session-subgroup-title";
      sectionTitle.textContent = group.title;
      sectionHead.appendChild(sectionTitle);
      section.appendChild(sectionHead);

      for (const session of group.sessions) {
        section.appendChild(buildSessionRow(session, project.projectDesktopState));
      }

      list.appendChild(section);
    }

    details.appendChild(list);
    sessionProjectsListEl.appendChild(details);
  }
}

async function loadSessionBrowser() {
  if (!sessionProjectsListEl) return null;
  if (sessionsLoadInFlight) return sessionBrowserState;
  sessionsLoadInFlight = true;
  if (refreshSessionsButtonEl) {
    refreshSessionsButtonEl.disabled = true;
  }
  try {
    const browser = await api("/api/sessions");
    sessionBrowserState = browser;
    renderSessionProjects(browser);
    return browser;
  } catch (error) {
    if (sessionsSummaryEl) {
      sessionsSummaryEl.textContent = error.message;
    }
    throw error;
  } finally {
    sessionsLoadInFlight = false;
    if (refreshSessionsButtonEl) {
      refreshSessionsButtonEl.disabled = false;
    }
  }
}

async function ensureCodexReady(actionLabel) {
  const processState = await api("/api/codex/processes");
  if (!processState.hasBlockingProcesses) return true;

  const summary = processState.processes
    .map((p) => `- ${p.label} (PID ${p.pid})`)
    .join("\n");
  const confirmed = window.confirm(
    `${actionLabel}前需要关闭这些 Codex 相关进程：\n\n${summary}\n\n是否现在由本页面自动关闭并继续？`
  );
  if (!confirmed) return false;

  showToast("正在关闭 Codex 相关进程...", "info");
  const closeResult = await api("/api/codex/close", { method: "POST" });
  if (!closeResult.ok) {
    const remaining = (closeResult.remaining || [])
      .map((p) => `${p.label} (PID ${p.pid})`)
      .join(", ");
    throw new Error(remaining ? `仍有进程未关闭: ${remaining}` : "关闭 Codex 相关进程失败");
  }
  return true;
}

async function loadState() {
  const state = await api("/api/state");
  const activeProfileChanged = lastSeenActiveProfile != null && lastSeenActiveProfile !== state.activeProfile;
  lastSeenActiveProfile = state.activeProfile || "";
  activeProfileEl.textContent = state.activeProfile;
  activeProfileEl.title = state.activeProfile || "";
  profilesDirEl.textContent = formatShortPath(state.profilesDir);
  loginStatusEl.textContent = formatLoginStatus(state.loginStatus);
  loginStatusEl.title = state.loginStatus || "";
  activeAccountEmailEl.textContent = state.activeAccount?.email || "未检测到";
  activeAccountEmailEl.title = state.activeAccount?.email || "";

  const activeUsageSummary = getUsageSummary(getDisplayUsage(`active:${state.activeProfile || "unknown"}`, state.activeUsage));
  activeUsageTitleEl.textContent = activeUsageSummary.title;
  activeUsageTitleEl.title = `${activeUsageSummary.title} · ${activeUsageSummary.meta}`;
  activeUsageMeterBarEl.style.width = `${activeUsageSummary.percent == null ? 0 : activeUsageSummary.percent}%`;
  activeUsageMeterBarEl.dataset.tone = activeUsageSummary.tone;
  renderUsageNotice(state.activeProfile, state.activeUsage);

  renderAutoSwitch(state.autoSwitch);
  renderProfiles(state.profiles);
  if (activeProfileChanged) {
    await loadSessionBrowser().catch(() => {});
  }
  return state;
}

async function maybeAutoRegister(state, { silent = false } = {}) {
  if (autoRegisterInFlight) return;
  const email = state.activeAccount?.email;
  if (!email) return;
  if (state.activeProfile === email) return;
  const alreadyExists = state.profiles.some((p) => p.profileName === email);
  if (alreadyExists) return;

  autoRegisterInFlight = true;
  try {
    const result = await api("/api/profile/auto-register-active", { method: "POST" });
    if (result.changed) {
      showToast(result.message || `已自动保存为 ${email}`, "success");
      await loadAndMaybeAutoRegister({ silent: true, allowAutoRegister: false });
    } else if (!silent && result.message) {
      showToast(result.message, "info");
    }
  } catch (error) {
    if (!silent) showToast(error.message, "error");
  } finally {
    autoRegisterInFlight = false;
  }
}

async function loadAndMaybeAutoRegister({ silent = false, allowAutoRegister = true } = {}) {
  const state = await loadState();
  if (allowAutoRegister) await maybeAutoRegister(state, { silent });
}

refreshSessionsButtonEl?.addEventListener("click", async () => {
  try {
    await loadSessionBrowser();
    showToast("会话列表已刷新", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
});

sessionSearchInputEl?.addEventListener("input", () => {
  renderSessionProjects(sessionBrowserState);
});

document.querySelector("#openCodexButton").addEventListener("click", async () => {
  try {
    const result = await api("/api/open/codex", { method: "POST" });
    showToast(result.ok ? "已打开 Codex" : "打开 Codex 失败", result.ok ? "success" : "error");
  } catch (error) {
    showToast(error.message, "error");
  }
});

rebuildSidebarButtonEl?.addEventListener("click", async () => {
  const ok = window.confirm("这会关闭并重新打开 Codex，同时清理桌面端本地侧边栏缓存。确定继续吗？");
  if (!ok) return;

  rebuildSidebarButtonEl.disabled = true;
  try {
    showToast("正在重建 Codex 侧边栏...", "info");
    const result = await api("/api/codex/rebuild-sidebar", { method: "POST" });
    showToast(result.message || "Codex 侧边栏已重建", "success");
    await loadAndMaybeAutoRegister({ silent: true, allowAutoRegister: false });
    await loadSessionBrowser().catch(() => {});
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    rebuildSidebarButtonEl.disabled = false;
  }
});

document.querySelector("#startLoginButton").addEventListener("click", async () => {
  try {
    const ready = await ensureCodexReady("CLI 登录");
    if (!ready) return;
    const result = await api("/api/login/start", { method: "POST" });
    showToast(result.message || "已打开 Terminal，请在终端里完成 codex login", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
});

document.querySelector("#startDeviceLoginButton").addEventListener("click", async () => {
  try {
    const ready = await ensureCodexReady("设备码登录");
    if (!ready) return;
    const result = await api("/api/login/start-device-auth", { method: "POST" });
    showToast(result.message || "已打开 Terminal，请按设备码流程登录", "success");
  } catch (error) {
    showToast(error.message, "error");
  }
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  const ok = window.confirm("确定执行 codex logout 吗？");
  if (!ok) return;
  try {
    const ready = await ensureCodexReady("CLI 登出");
    if (!ready) return;
    const result = await api("/api/login/logout", { method: "POST" });
    showToast(result.message || "已登出", "success");
    await loadAndMaybeAutoRegister({ allowAutoRegister: false });
  } catch (error) {
    showToast(error.message, "error");
  }
});

autoSwitchToggleButtonEl.addEventListener("click", async () => {
  const enable = autoSwitchToggleButtonEl.dataset.mode !== "on";
  autoSwitchToggleButtonEl.disabled = true;
  try {
    const result = await api("/api/auto-switch", {
      method: "POST",
      body: { enabled: enable }
    });
    renderAutoSwitch(result.autoSwitch);
    showToast(enable ? "自动切号已开启" : "自动切号已关闭", "success");
    await loadState();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    autoSwitchToggleButtonEl.disabled = false;
  }
});

checkUpdateButtonEl.addEventListener("click", async () => {
  try {
    const appState = await loadVersionState({ force: true });
    if (appState?.update?.available) {
      showToast(`发现 ${appState.update.latestVersionLabel}`, "success");
    } else {
      showToast("当前已经是最新版本", "success");
    }
  } catch (error) {
    showToast(error.message, "error");
  }
});

installUpdateButtonEl.addEventListener("click", async () => {
  if (!appVersionState?.update?.available) return;
  const ok = window.confirm(`现在安装 ${appVersionState.update.latestVersionLabel} 并直接替换当前应用吗？应用会自动退出并重启。`);
  if (!ok) return;
  installUpdateButtonEl.disabled = true;
  try {
    const result = await api("/api/app/update/install", { method: "POST" });
    if (result.install) {
      renderVersionState({
        ...appVersionState,
        install: result.install
      });
    } else {
      appUpdateStatusEl.textContent = "正在后台安装更新…";
    }
    showToast(result.message || "正在安装更新", "success");
  } catch (error) {
    installUpdateButtonEl.disabled = false;
    showToast(error.message, "error");
  }
});

usageNoticeCloseEl.addEventListener("click", () => {
  dismissedUsageNoticeKey = usageNoticeCloseEl.dataset.noticeKey || null;
  usageNoticeEl.classList.add("hidden");
});

loadAndMaybeAutoRegister({ silent: true }).catch((error) => {
  showToast(error.message, "error");
});
loadSessionBrowser().catch(() => {});
loadVersionState().catch(() => {});

setInterval(() => {
  loadAndMaybeAutoRegister({ silent: true }).catch(() => {});
}, 5000);

setInterval(() => {
  loadSessionBrowser().catch(() => {});
}, 60 * 1000);

setInterval(() => {
  loadVersionState().catch(() => {});
}, 10 * 60 * 1000);
