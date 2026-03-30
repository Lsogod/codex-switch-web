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
let autoRegisterInFlight = false;
const expandedProfiles = new Set();

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
  if (!usage) return { title: "未查询额度", meta: "-", percent: 0, tone: "warn" };
  if (usage.ok === false) return { title: "额度不可用", meta: usage.error || "查询失败", percent: 0, tone: "danger" };
  const data = usage.data;
  if (!data || !data.summary || data.summary.remainingPercent == null) {
    return { title: "额度不可用", meta: "当前账号未返回额度信息", percent: 0, tone: "warn" };
  }
  const percent = clampPercent(data.summary.remainingPercent);
  return {
    title: `${getUsageStatusLabel(percent)} · ${percent}%`,
    meta: `${data.summary.label} · ${formatResetLabel(data.summary.resetAt)}`,
    percent,
    tone: getUsageTone(percent)
  };
}

function renderUsageBox(node, usage) {
  const titleEl = node.querySelector(".usage-title");
  const noteEl = node.querySelector(".usage-note");
  const badgeEl = node.querySelector(".usage-badge");
  const linesEl = node.querySelector(".usage-lines");
  const summary = getUsageSummary(usage);
  const entries = getUsageEntries(usage);
  const credit = getCreditSummary(usage);

  titleEl.textContent = summary.title;
  noteEl.textContent = summary.meta;
  badgeEl.textContent = `${summary.percent}%`;
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

function renderStripUsage(node, usage) {
  const pctEl = node.querySelector(".strip-usage-pct");
  const fillEl = node.querySelector(".strip-usage-fill");
  const summary = getUsageSummary(usage);

  pctEl.textContent = `${summary.percent}%`;
  pctEl.dataset.tone = summary.tone;
  fillEl.style.width = `${summary.percent}%`;
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

function renderStripReset(node, usage) {
  const labelEl = node.querySelector(".strip-reset-label");
  const resetTime = getResetTimeShort(usage);
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
    renderStripUsage(node, profile.usage);

    // Detail facts
    node.querySelector(".fact-name").textContent = profile.displayName || "-";
    node.querySelector(".fact-auth-mode").textContent = profile.authMode || "-";
    node.querySelector(".fact-plan").textContent = planLabel;
    node.querySelector(".fact-refresh").textContent = formatTime(profile.lastRefresh);
    node.querySelector(".fact-path").textContent = formatShortPath(profile.path);

    // Reset time & usage box
    renderStripReset(node, profile.usage);
    renderUsageBox(node, profile.usage);

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
  activeProfileEl.textContent = state.activeProfile;
  profilesDirEl.textContent = formatShortPath(state.profilesDir);
  loginStatusEl.textContent = state.loginStatus || "-";
  activeAccountEmailEl.textContent = state.activeAccount?.email || "未检测到";

  const activeUsageSummary = getUsageSummary(state.activeUsage);
  activeUsageTitleEl.textContent = activeUsageSummary.title;
  activeUsageMeterBarEl.style.width = `${activeUsageSummary.percent}%`;
  activeUsageMeterBarEl.dataset.tone = activeUsageSummary.tone;

  renderAutoSwitch(state.autoSwitch);
  renderProfiles(state.profiles);
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

loadAndMaybeAutoRegister({ silent: true }).catch((error) => {
  showToast(error.message, "error");
});

setInterval(() => {
  loadAndMaybeAutoRegister({ silent: true }).catch(() => {});
}, 5000);
