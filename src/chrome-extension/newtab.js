// ── Config ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = "open-brain-config";
const TOP_N = 3;

// Use chrome.storage.local for reliability in extension context, fallback to localStorage
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
  // Match: "дедлайн 30 марта 2026" or "дедлайн: 30 марта" or "[дедлайн 30 марта 2026]"
  const pattern = /дедлайн[:\s]*(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?/i;
  const match = text.match(pattern);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = MONTHS_RU[match[2].toLowerCase()];
  const year = match[3] ? parseInt(match[3], 10) : new Date().getFullYear();

  if (month === undefined) return null;
  return new Date(year, month, day).getTime();
}

// ── Pick top 3 tasks ───────────────────────────────────────────────────────

function pickTopTasks(tasks, projects) {
  // Build project lookup
  const projectMap = {};
  for (const p of projects) {
    projectMap[p.id] = p.name;
  }

  // Filter to open tasks only
  const open = tasks.filter((t) => {
    const s = t.metadata?.status;
    return s !== "done" && s !== "cancelled";
  });

  // Score each task for priority
  const scored = open.map((task) => {
    const meta = task.metadata || {};
    let score = 0;

    // in_progress gets highest priority
    if (meta.status === "in_progress") score += 1000;

    // Tasks linked to projects get a boost
    if (meta.linked_projects?.length > 0) score += 200;

    // Newer tasks score higher (within last 7 days)
    const ageMs = Date.now() - new Date(task.created_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 1) score += 100;
    else if (ageDays < 3) score += 50;
    else if (ageDays < 7) score += 20;

    const content = task.content.toLowerCase();

    // --- Concrete deadline detection ---
    // Match patterns like "дедлайн 30 марта 2026", "дедлайн: 30 марта", "[дедлайн 30 марта 2026]"
    const deadlineDate = extractDeadlineDate(content);
    if (deadlineDate) {
      const daysUntil = (deadlineDate - new Date().setHours(0,0,0,0)) / (1000 * 60 * 60 * 24);
      if (daysUntil < 0) score += 500;        // overdue
      else if (daysUntil <= 1) score += 450;   // today or tomorrow
      else if (daysUntil <= 3) score += 350;   // within 3 days
      else if (daysUntil <= 7) score += 200;   // within a week
      else score += 50;                        // has deadline but far away
    }

    // Keyword urgency (only if no concrete deadline detected)
    if (!deadlineDate) {
      if (content.includes("срочно") || content.includes("asap")) score += 300;
      if (content.includes("сегодня") || content.includes("today")) score += 250;
      if (content.includes("завтра") || content.includes("tomorrow")) score += 150;
      if (content.includes("дедлайн") || content.includes("deadline")) score += 100;
    }

    // --- Blocked / waiting tasks get penalized ---
    // "после завершения", "после получения", "ждём", "когда будет"
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

    // "ПОСТОЯННАЯ ЗАДАЧА" — ongoing, not urgent today
    if (content.includes("постоянная задача")) {
      score -= 200;
    }

    // Get project name
    const linkedProjects = (meta.linked_projects || [])
      .map((pid) => projectMap[pid])
      .filter(Boolean);

    return { ...task, score, projectName: linkedProjects[0] || null };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// Global task queue — top 3 are visible, rest are waiting
let taskQueue = [];

// ── Truncate long task text ────────────────────────────────────────────────

function truncate(text, maxLen = 120) {
  if (text.length <= maxLen) return text;
  // Try to cut at a word boundary
  const cut = text.lastIndexOf(" ", maxLen);
  return text.slice(0, cut > 80 ? cut : maxLen) + "...";
}

// ── Rendering ──────────────────────────────────────────────────────────────

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

  // Checkbox handlers
  el.querySelectorAll(".task-check").forEach((cb) => {
    cb.addEventListener("click", handleCheck);
  });
}

async function handleCheck(e) {
  const cb = e.currentTarget;
  const id = cb.dataset.id;
  const item = cb.closest(".task-item");

  // Prevent double-click
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

  // Remove from queue
  taskQueue = taskQueue.filter((t) => t.id !== id);

  // Animate out
  item.classList.add("leaving");

  item.addEventListener("animationend", () => {
    // Rebuild the visible list
    const el = document.getElementById("tasks");
    const visible = taskQueue.slice(0, TOP_N);

    if (visible.length === 0) {
      el.innerHTML = '<li class="task-item entering" style="text-align:center; display:block;"><span class="task-text" style="color:#444">Все задачи выполнены. Красота.</span></li>';
      document.getElementById("remaining").classList.add("hidden");
      return;
    }

    el.innerHTML = visible.map((task, i) => buildTaskHtml(task, i)).join("");
    updateRemaining();

    // Mark the last item (newly appeared) with enter animation
    const items = el.querySelectorAll(".task-item");
    if (items.length > 0) {
      const lastItem = items[items.length - 1];
      lastItem.classList.add("entering");
    }

    // Re-bind checkbox handlers
    el.querySelectorAll(".task-check").forEach((c) => {
      c.addEventListener("click", handleCheck);
    });
  }, { once: true });
}

// ── Settings ───────────────────────────────────────────────────────────────

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
    // Highlight empty fields
    if (!endpoint) document.getElementById("settings-endpoint").style.borderColor = "#c66";
    if (!key) document.getElementById("settings-key").style.borderColor = "#c66";
    return;
  }

  await saveConfig(endpoint, key);
  hideSettings();
  init();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideSettings();
});

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  document.getElementById("greeting").textContent = getGreeting();
  document.getElementById("date").textContent = formatDate();

  const config = await getConfig();

  document.getElementById("loading").classList.remove("hidden");
  document.getElementById("error").classList.add("hidden");
  document.getElementById("no-config").classList.add("hidden");
  document.getElementById("focus").classList.add("hidden");

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

    taskQueue = pickTopTasks(tasks, projects);

    document.getElementById("loading").classList.add("hidden");
    document.getElementById("focus").classList.remove("hidden");

    renderTasks();
  } catch (err) {
    document.getElementById("loading").classList.add("hidden");
    const errorEl = document.getElementById("error");
    errorEl.textContent = `Ошибка: ${err.message}`;
    errorEl.classList.remove("hidden");
  }
}

init();
