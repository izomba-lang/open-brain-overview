// ── Config ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = "open-brain-config";
const TOP_N = 3;

async function getConfig() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.get(STORAGE_KEY, (result) => {
          resolve(result[STORAGE_KEY] || null);
        });
      });
    }
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

async function saveConfig(endpoint, key) {
  const config = { endpoint, key };
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: config }, resolve);
    });
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

// ── MCP API ────────────────────────────────────────────────────────────────

async function mcpCall(toolName, args = {}) {
  const config = await getConfig();
  if (!config) throw new Error("Not configured");

  const url = `${config.endpoint}?key=${config.key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.result?.content?.[0]?.text;
  if (!text) throw new Error("Empty response");
  return JSON.parse(text);
}

async function markDone(id) {
  return mcpCall("update_thought", { id, status: "done" });
}

// ── Deadline parsing ──────────────────────────────────────────────────────

const MONTHS_RU = {
  "января": 0, "февраля": 1, "марта": 2, "апреля": 3,
  "мая": 4, "июня": 5, "июля": 6, "августа": 7,
  "сентября": 8, "октября": 9, "ноября": 10, "декабря": 11,
};

function extractDeadlineDate(text) {
  const pattern = /дедлайн[:\s]*(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?/i;
  const match = text.match(pattern);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = MONTHS_RU[match[2].toLowerCase()];
  const year = match[3] ? parseInt(match[3], 10) : new Date().getFullYear();

  if (month === undefined) return null;
  return new Date(year, month, day).getTime();
}

// ── Pick top tasks ───────────────────────────────────────────────────────

function pickTopTasks(tasks, projects) {
  const projectMap = {};
  for (const p of projects) {
    projectMap[p.id] = p.name;
  }

  const open = tasks.filter((t) => {
    const s = t.metadata?.status;
    return s !== "done" && s !== "cancelled";
  });

  const scored = open.map((task) => {
    const meta = task.metadata || {};
    let score = 0;

    if (meta.status === "in_progress") score += 1000;
    if (meta.linked_projects?.length > 0) score += 200;

    const ageMs = Date.now() - new Date(task.created_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 1) score += 100;
    else if (ageDays < 3) score += 50;
    else if (ageDays < 7) score += 20;

    const content = task.content.toLowerCase();

    const deadlineDate = extractDeadlineDate(content);
    if (deadlineDate) {
      const daysUntil = (deadlineDate - new Date().setHours(0,0,0,0)) / (1000 * 60 * 60 * 24);
      if (daysUntil < 0) score += 500;
      else if (daysUntil <= 1) score += 450;
      else if (daysUntil <= 3) score += 350;
      else if (daysUntil <= 7) score += 200;
      else score += 50;
    }

    if (!deadlineDate) {
      if (content.includes("срочно") || content.includes("asap")) score += 300;
      if (content.includes("сегодня") || content.includes("today")) score += 250;
      if (content.includes("завтра") || content.includes("tomorrow")) score += 150;
      if (content.includes("дедлайн") || content.includes("deadline")) score += 100;
    }

    if (
      content.includes("после завершения") ||
      content.includes("после получения") ||
      content.includes("после координации") ||
      content.includes("ждём") ||
      content.includes("когда будет") ||
      content.includes("пришлёт") ||
      content.includes("ожидаю получить")
    ) {
      score -= 300;
    }

    if (content.includes("постоянная задача")) {
      score -= 200;
    }

    const linkedProjects = (meta.linked_projects || [])
      .map((pid) => projectMap[pid])
      .filter(Boolean);

    return { ...task, score, projectName: linkedProjects[0] || null };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// Global state
let taskQueue = [];
let allTasks = [];
let allProjects = [];

// ── Truncate ────────────────────────────────────────────────────────────

function truncate(text, maxLen = 120) {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(" ", maxLen);
  return text.slice(0, cut > 80 ? cut : maxLen) + "...";
}

// ── Rendering — Focus view ──────────────────────────────────────────────

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

function formatDate() {
  return new Date().toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function buildTaskHtml(task, index) {
  const projectTag = task.projectName
    ? `<span class="task-project">${escapeHtml(task.projectName)}</span>`
    : "";
  const skillTag = task.metadata?.suggested_skill
    ? `<span class="task-skill">${escapeHtml(task.metadata.suggested_skill)}</span>`
    : "";

  return `
    <li class="task-item" data-id="${task.id}">
      <span class="task-number">${index + 1}</span>
      <div class="task-body">
        <div class="task-text">${escapeHtml(truncate(task.content))}</div>
        <div class="task-tags">${projectTag}${skillTag}</div>
      </div>
      <div class="task-check" data-id="${task.id}"></div>
    </li>`;
}

function updateRemaining() {
  const rem = document.getElementById("remaining");
  const waiting = taskQueue.length - TOP_N;
  if (waiting > 0) {
    rem.textContent = `+ ещё ${waiting} задач`;
    rem.classList.remove("hidden");
  } else {
    rem.classList.add("hidden");
  }
}

function renderTasks() {
  const el = document.getElementById("tasks");

  if (taskQueue.length === 0) {
    el.innerHTML = '<li class="task-item" style="opacity:1; text-align:center; display:block;"><span class="task-text" style="color:#444">Нет открытых задач. Свободный день.</span></li>';
    return;
  }

  const visible = taskQueue.slice(0, TOP_N);
  el.innerHTML = visible.map((task, i) => buildTaskHtml(task, i)).join("");

  updateRemaining();

  el.querySelectorAll(".task-check").forEach((cb) => {
    cb.addEventListener("click", handleCheck);
  });
}

async function handleCheck(e) {
  const cb = e.currentTarget;
  const id = cb.dataset.id;
  const item = cb.closest(".task-item");

  if (item.classList.contains("leaving")) return;

  cb.classList.add("done");
  item.classList.add("checked");

  try {
    await markDone(id);
  } catch (err) {
    cb.classList.remove("done");
    item.classList.remove("checked");
    console.error("Failed:", err);
    return;
  }

  taskQueue = taskQueue.filter((t) => t.id !== id);
  item.classList.add("leaving");

  item.addEventListener("animationend", () => {
    const el = document.getElementById("tasks");
    const visible = taskQueue.slice(0, TOP_N);

    if (visible.length === 0) {
      el.innerHTML = '<li class="task-item entering" style="text-align:center; display:block;"><span class="task-text" style="color:#444">Все задачи выполнены. Красота.</span></li>';
      document.getElementById("remaining").classList.add("hidden");
      return;
    }

    el.innerHTML = visible.map((task, i) => buildTaskHtml(task, i)).join("");
    updateRemaining();

    const items = el.querySelectorAll(".task-item");
    if (items.length > 0) {
      items[items.length - 1].classList.add("entering");
    }

    el.querySelectorAll(".task-check").forEach((c) => {
      c.addEventListener("click", handleCheck);
    });
  }, { once: true });
}

// ══════════════════════════════════════════════════════════════════════════
// EXPLORE DASHBOARD
// ══════════════════════════════════════════════════════════════════════════

const TYPE_EMOJI = {
  idea: "💡", task: "✅", reflection: "🪞", note: "📝",
  question: "❓", event: "📅", decision: "⚖️", insight: "🔍",
};

const AREA_LABELS = {
  work: "Работа", personal: "Личное", learning: "Обучение",
  health: "Здоровье", finance: "Финансы", social: "Социальное",
};

function showExplore() {
  document.getElementById("focus").classList.add("hidden");
  document.getElementById("explore").classList.remove("hidden");
  document.body.classList.add("explore-open");
  loadExploreData();
}

function showFocus() {
  document.getElementById("explore").classList.add("hidden");
  document.getElementById("focus").classList.remove("hidden");
  document.body.classList.remove("explore-open");
}

async function loadExploreData() {
  try {
    const [stats, thoughts, people] = await Promise.all([
      mcpCall("thought_stats"),
      mcpCall("list_thoughts", { limit: 50, days: 30 }),
      mcpCall("list_people", { limit: 20 }),
    ]);

    renderStats(stats);
    renderProjects(allProjects, allTasks);
    renderHeatmap(thoughts);
    renderAreas(stats);
    renderPeople(stats, people);
    renderTimeline(thoughts);
  } catch (err) {
    console.error("Explore load error:", err);
  }
}

// ── Stats ──────────────────────────────────────────────────────────────

function renderStats(stats) {
  const openTasks = taskQueue.length;
  const activeProjects = allProjects.filter(p => p.status === "active").length;

  const el = document.getElementById("stats-row");
  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${stats.total}</div>
      <div class="stat-label">мыслей</div>
      <div class="stat-sub positive">+${stats.last_7_days} за 7д</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${activeProjects}</div>
      <div class="stat-label">проектов</div>
      <div class="stat-sub">active</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${openTasks}</div>
      <div class="stat-label">задач</div>
      <div class="stat-sub">open</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${Object.keys(stats.top_people || {}).length || stats.top_people?.length || 0}</div>
      <div class="stat-label">людей</div>
      <div class="stat-sub">&nbsp;</div>
    </div>
  `;
}

// ── Projects ───────────────────────────────────────────────────────────

function renderProjects(projects, tasks) {
  const el = document.getElementById("projects-list");

  if (!projects || projects.length === 0) {
    el.innerHTML = '<div class="dash-empty">Нет проектов</div>';
    return;
  }

  // Count tasks per project
  const projectTaskCounts = {};
  for (const t of tasks) {
    const linkedProjects = t.metadata?.linked_projects || [];
    const isDone = t.metadata?.status === "done" || t.metadata?.status === "cancelled";
    for (const pid of linkedProjects) {
      if (!projectTaskCounts[pid]) projectTaskCounts[pid] = { total: 0, done: 0 };
      projectTaskCounts[pid].total++;
      if (isDone) projectTaskCounts[pid].done++;
    }
  }

  const active = projects.filter(p => p.status !== "completed" && p.status !== "archived");
  const completed = projects.filter(p => p.status === "completed");
  const sorted = [...active, ...completed].slice(0, 8);

  el.innerHTML = sorted.map(p => {
    const counts = projectTaskCounts[p.id] || { total: 0, done: 0 };
    const pct = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;
    const barColor = p.status === "completed" ? "dim" : pct > 70 ? "green" : pct > 30 ? "blue" : "orange";

    let deadlineHtml = "";
    if (p.deadline) {
      const dl = new Date(p.deadline);
      const daysLeft = Math.ceil((dl - new Date()) / (1000 * 60 * 60 * 24));
      if (p.status !== "completed") {
        const cls = daysLeft < 0 ? "urgent" : daysLeft <= 3 ? "urgent" : daysLeft <= 7 ? "soon" : "";
        const label = daysLeft < 0 ? `${Math.abs(daysLeft)}д просрочен` : daysLeft === 0 ? "сегодня" : `${daysLeft}д`;
        deadlineHtml = `<span class="project-deadline ${cls}">⏰ ${label}</span>`;
      }
    }

    const statusCls = p.status || "active";

    return `
      <div class="project-row">
        <div class="project-info">
          <div class="project-name">${escapeHtml(p.name)}</div>
          <div class="project-meta">${p.area || ""}</div>
        </div>
        <div class="project-bar-wrap">
          <div class="project-bar-bg">
            <div class="project-bar-fill ${barColor}" style="width: ${pct}%"></div>
          </div>
          <div class="project-count">${counts.done}/${counts.total}</div>
        </div>
        ${deadlineHtml}
        <span class="project-status ${statusCls}">${statusCls}</span>
      </div>`;
  }).join("");
}

// ── Heatmap ────────────────────────────────────────────────────────────

function renderHeatmap(thoughts) {
  const el = document.getElementById("heatmap");
  const labelsEl = document.getElementById("heatmap-labels");

  // Count per day for last 30 days
  const dayCounts = {};
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const t of thoughts) {
    const d = new Date(t.created_at);
    const key = d.toISOString().slice(0, 10);
    dayCounts[key] = (dayCounts[key] || 0) + 1;
  }

  let maxCount = 0;
  for (const v of Object.values(dayCounts)) {
    if (v > maxCount) maxCount = v;
  }

  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const count = dayCounts[key] || 0;
    let level = "";
    if (count > 0) {
      const ratio = count / (maxCount || 1);
      if (ratio > 0.75) level = "l4";
      else if (ratio > 0.5) level = "l3";
      else if (ratio > 0.25) level = "l2";
      else level = "l1";
    }
    const dayLabel = d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
    days.push(`<div class="heatmap-day ${level}" data-tip="${dayLabel}: ${count}"></div>`);
  }

  el.innerHTML = days.join("");

  // Labels: first and last dates
  const firstDate = new Date(today);
  firstDate.setDate(firstDate.getDate() - 29);
  labelsEl.innerHTML = `
    <span>${firstDate.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</span>
    <span>${today.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</span>
  `;
}

// ── Areas ──────────────────────────────────────────────────────────────

function renderAreas(stats) {
  const el = document.getElementById("areas-chart");

  // Extract area counts from types data — we need to use source data
  // stats.types gives type breakdown, but we need area. Let's compute from available data.
  // Since thought_stats doesn't return areas directly, we'll count from the source breakdown
  // or use what we have. Let's check if stats has source/area info.

  // Actually, stats only has types, top_topics, top_people. For areas we need to count from thoughts.
  // We already have allTasks which are all task-type thoughts. Let's count areas from those + recent thoughts.
  // Better approach: count from all loaded thoughts data.

  // For now, approximate from the tasks we already have
  const areaCounts = {};
  for (const t of allTasks) {
    const area = t.metadata?.area || "other";
    areaCounts[area] = (areaCounts[area] || 0) + 1;
  }

  const sorted = Object.entries(areaCounts).sort(([, a], [, b]) => b - a);
  const maxVal = sorted.length > 0 ? sorted[0][1] : 1;

  if (sorted.length === 0) {
    el.innerHTML = '<div class="dash-empty">Нет данных</div>';
    return;
  }

  el.innerHTML = sorted.slice(0, 6).map(([area, count]) => {
    const pct = Math.round((count / maxVal) * 100);
    const label = AREA_LABELS[area] || area;
    const colorClass = area;
    return `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(label)}</span>
        <div class="bar-track"><div class="bar-fill ${colorClass}" style="width: ${pct}%"></div></div>
        <span class="bar-value">${count}</span>
      </div>`;
  }).join("");
}

// ── People ─────────────────────────────────────────────────────────────

function renderPeople(stats, people) {
  const el = document.getElementById("people-chart");
  const topPeople = stats.top_people || [];

  if (topPeople.length === 0) {
    el.innerHTML = '<div class="dash-empty">Нет упоминаний</div>';
    return;
  }

  const maxVal = topPeople[0]?.count || 1;

  el.innerHTML = topPeople.slice(0, 6).map(({ person, count }) => {
    const pct = Math.round((count / maxVal) * 100);
    return `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(person)}</span>
        <div class="bar-track"><div class="bar-fill people" style="width: ${pct}%"></div></div>
        <span class="bar-value">${count}</span>
      </div>`;
  }).join("");
}

// ── Timeline ───────────────────────────────────────────────────────────

function renderTimeline(thoughts) {
  const el = document.getElementById("timeline");

  if (!thoughts || thoughts.length === 0) {
    el.innerHTML = '<div class="dash-empty">Нет записей</div>';
    return;
  }

  // Group by date
  const grouped = {};
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  for (const t of thoughts.slice(0, 30)) {
    const dateKey = t.created_at.slice(0, 10);
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(t);
  }

  let html = "";
  for (const [date, items] of Object.entries(grouped)) {
    let dateLabel;
    if (date === today) dateLabel = "Сегодня";
    else if (date === yesterday) dateLabel = "Вчера";
    else dateLabel = new Date(date).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

    html += `<div class="timeline-date">${dateLabel}</div>`;

    for (const t of items) {
      const type = t.metadata?.type || "note";
      const emoji = TYPE_EMOJI[type] || "📝";
      const topic = t.metadata?.topic ? `<span class="timeline-topic">${escapeHtml(t.metadata.topic)}</span>` : "";

      html += `
        <div class="timeline-item">
          <span class="timeline-icon">${emoji}</span>
          <span class="timeline-content">${escapeHtml(truncate(t.content, 100))}${topic}</span>
        </div>`;
    }
  }

  el.innerHTML = html;
}

// ── Settings ───────────────────────────────────────────────────────────

function showSettings() {
  const config = getConfig();
  document.getElementById("settings-endpoint").value = config?.endpoint || "";
  document.getElementById("settings-key").value = config?.key || "";
  document.getElementById("settings-overlay").classList.remove("hidden");
}

function hideSettings() {
  document.getElementById("settings-overlay").classList.add("hidden");
}

document.getElementById("gear-btn").addEventListener("click", showSettings);
document.getElementById("setup-btn")?.addEventListener("click", showSettings);
document.getElementById("settings-cancel").addEventListener("click", hideSettings);
document.getElementById("settings-save").addEventListener("click", async () => {
  const endpoint = document.getElementById("settings-endpoint").value.trim();
  const key = document.getElementById("settings-key").value.trim();

  if (!endpoint || !key) {
    if (!endpoint) document.getElementById("settings-endpoint").style.borderColor = "#c66";
    if (!key) document.getElementById("settings-key").style.borderColor = "#c66";
    return;
  }

  await saveConfig(endpoint, key);
  hideSettings();
  init();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!document.getElementById("explore").classList.contains("hidden")) {
      showFocus();
    } else {
      hideSettings();
    }
  }
});

// ── Explore / Collapse buttons ─────────────────────────────────────────

document.getElementById("explore-btn").addEventListener("click", showExplore);
document.getElementById("collapse-btn").addEventListener("click", showFocus);

// ── Init ───────────────────────────────────────────────────────────────

async function init() {
  document.getElementById("greeting").textContent = getGreeting();
  document.getElementById("date").textContent = formatDate();

  const config = await getConfig();

  document.getElementById("loading").classList.remove("hidden");
  document.getElementById("error").classList.add("hidden");
  document.getElementById("no-config").classList.add("hidden");
  document.getElementById("focus").classList.add("hidden");
  document.getElementById("explore").classList.add("hidden");
  document.body.classList.remove("explore-open");

  if (!config) {
    document.getElementById("loading").classList.add("hidden");
    document.getElementById("no-config").classList.remove("hidden");
    return;
  }

  try {
    const [tasks, projects] = await Promise.all([
      mcpCall("list_thoughts", { type: "task", limit: 100 }),
      mcpCall("list_projects", { limit: 50 }),
    ]);

    allTasks = tasks;
    allProjects = projects;
    taskQueue = pickTopTasks(tasks, projects);

    document.getElementById("loading").classList.add("hidden");
    document.getElementById("focus").classList.remove("hidden");
    document.getElementById("explore-btn").classList.remove("hidden");

    renderTasks();
  } catch (err) {
    document.getElementById("loading").classList.add("hidden");
    const errorEl = document.getElementById("error");
    errorEl.textContent = `Ошибка: ${err.message}`;
    errorEl.classList.remove("hidden");
  }
}

init();
