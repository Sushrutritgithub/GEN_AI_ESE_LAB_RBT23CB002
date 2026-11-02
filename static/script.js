"use strict";

const API_CHAT = "/api/chat";
const API_HEALTH = "/api/health";
const MAX_HISTORY_MESSAGES = 10; // 5 exchanges
const REQUEST_TIMEOUT_MS = 150000;

const TOPICS = [
  "DSA", "OS", "DBMS", "Networks", "Computer Architecture", "OOP",
  "Software Engineering", "AI", "ML", "Computer Graphics", "Compiler Design",
];

const SAMPLE_QUESTIONS = [
  "Explain an operating system.",
  "Explain deadlock and its four necessary conditions.",
  "Process vs thread.",
  "Explain binary search with C++ code.",
  "What is normalization in DBMS?",
  "How does TCP differ from UDP?",
];

/* ------------------------------------------------------------------
   Safe Markdown rendering: all text is HTML-escaped before any tags
   are produced, and only a fixed set of tags is ever generated.
------------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(text) {
  const codes = [];
  let out = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return "\u0000" + (codes.length - 1) + "\u0000";
  });
  out = escapeHtml(out);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + escapeHtml(codes[Number(i)]) + "</code>");
  return out;
}

function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let para = [];
  let listTag = null;
  let inCode = false;
  let codeLang = "";
  let code = [];

  const flushPara = () => {
    if (para.length) {
      html.push("<p>" + para.map(renderInline).join("<br>") + "</p>");
      para = [];
    }
  };
  const closeList = () => {
    if (listTag) {
      html.push("</" + listTag + ">");
      listTag = null;
    }
  };
  const flushCode = () => {
    const lang = codeLang ? ' data-lang="' + escapeHtml(codeLang) + '"' : "";
    html.push("<pre" + lang + "><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
    code = [];
    codeLang = "";
  };
  const openList = (tag) => {
    if (listTag !== tag) {
      closeList();
      html.push("<" + tag + ">");
      listTag = tag;
    }
  };

  for (const line of lines) {
    if (inCode) {
      if (/^\s*```\s*$/.test(line)) {
        flushCode();
        inCode = false;
      } else {
        code.push(line);
      }
      continue;
    }

    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flushPara();
      closeList();
      inCode = true;
      codeLang = fence[1];
      code = [];
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushPara(); // keep an open list so blank-separated items stay in one list
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      html.push("<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">");
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      closeList();
      html.push("<hr>");
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      openList("ul");
      html.push("<li>" + renderInline(ul[1]) + "</li>");
      continue;
    }

    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ol) {
      flushPara();
      openList("ol");
      html.push("<li>" + renderInline(ol[1]) + "</li>");
      continue;
    }

    closeList();
    para.push(line.trim());
  }

  if (inCode) flushCode(); // unterminated fence
  flushPara();
  closeList();
  return html.join("\n");
}

function formatMetrics(m) {
  if (!m) return "";
  const parts = [];
  if (m.model) parts.push(m.model);
  if (typeof m.prompt_eval_count === "number") parts.push("prompt: " + m.prompt_eval_count + " tok");
  if (typeof m.eval_count === "number") parts.push("generated: " + m.eval_count + " tok");
  if (typeof m.tokens_per_second === "number") parts.push(m.tokens_per_second + " tok/s");
  if (typeof m.total_duration === "number") parts.push((m.total_duration / 1e9).toFixed(2) + " s total");
  return parts.join(" · ");
}

// ---- UI ----
const els = {
  sidebar: document.getElementById("sidebar"),
  menuBtn: document.getElementById("menuBtn"),
  messages: document.getElementById("messages"),
  emptyState: document.getElementById("emptyState"),
  input: document.getElementById("input"),
  sendBtn: document.getElementById("sendBtn"),
  clearBtn: document.getElementById("clearBtn"),
  status: document.getElementById("status"),
  statusText: document.getElementById("statusText"),
  modelName: document.getElementById("modelName"),
  topics: document.getElementById("topics"),
  samples: document.getElementById("samples"),
  emptySamples: document.getElementById("emptySamples"),
};

let history = [];
let busy = false;

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addMessage(kind, text, metrics) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + kind;

  const role = document.createElement("div");
  role.className = "role";
  role.textContent = kind === "user" ? "You" : kind === "assistant" ? "CS Tutor" : "Error";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (kind === "assistant") bubble.innerHTML = renderMarkdown(text);
  else bubble.textContent = text;

  wrap.append(role, bubble);

  if (kind === "assistant") {
    const info = formatMetrics(metrics);
    if (info) {
      const meta = document.createElement("div");
      meta.className = "metrics";
      meta.textContent = info;
      wrap.append(meta);
    }
  }

  els.messages.append(wrap);
  scrollToBottom();
  return wrap;
}

function addLoader() {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  wrap.innerHTML =
    '<div class="role">CS Tutor</div><div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>';
  els.messages.append(wrap);
  scrollToBottom();
  return wrap;
}

function setBusy(value) {
  busy = value;
  els.sendBtn.disabled = value;
  els.sendBtn.textContent = value ? "Thinking…" : "Send";
  document.querySelectorAll(".sample").forEach((b) => (b.disabled = value));
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}

function extractDetail(data) {
  return data && typeof data.detail === "string" ? data.detail : "";
}

async function sendQuestion(text) {
  const question = text.trim();
  if (!question || busy) return;

  setBusy(true);
  els.emptyState.style.display = "none";
  els.sidebar.classList.remove("open");
  addMessage("user", question);
  els.input.value = "";
  autoGrow();
  const loader = addLoader();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(API_CHAT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history: history.slice(-MAX_HISTORY_MESSAGES) }),
      signal: controller.signal,
    });

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }

    if (!res.ok) throw new Error(extractDetail(data) || "Request failed (HTTP " + res.status + ").");
    if (!data || typeof data.answer !== "string") throw new Error("The server returned an unexpected response.");

    loader.remove();
    addMessage("assistant", data.answer, data.metrics);
      if (data.in_scope !== false) { // redirects are not stored as context
      history.push({ role: "user", content: question }, { role: "assistant", content: data.answer });
      history = history.slice(-MAX_HISTORY_MESSAGES);
    }
  } catch (err) {
    loader.remove();
    let msg;
    if (err.name === "AbortError") {
      msg = "The request timed out. The model may be loading or busy. Please try again.";
    } else if (err instanceof TypeError) {
      msg = "Cannot reach the backend. Check that the server is running (uvicorn main:app) and try again.";
    } else {
      msg = err.message || "Something went wrong.";
    }
    addMessage("error", msg);
  } finally {
    clearTimeout(timer);
    setBusy(false);
    els.input.focus();
    checkHealth();
  }
}

function clearChat() {
  history = [];
  els.messages.querySelectorAll(".msg").forEach((n) => n.remove());
  els.emptyState.style.display = "";
  els.sidebar.classList.remove("open");
  els.input.focus();
}

function setStatus(kind, text) {
  els.status.className = "status " + kind;
  els.statusText.textContent = text;
}

async function checkHealth() {
  try {
    const res = await fetch(API_HEALTH);
    const data = await res.json();
    if (data.model) {
      els.modelName.textContent = data.model;
    }
    if (data.status === "ok") setStatus("ok", "Ollama connected");
    else if (data.ollama === "ok") setStatus("warn", "Model not found in Ollama");
    else setStatus("bad", "Ollama unreachable");
  } catch (_) {
    setStatus("bad", "Backend offline");
  }
}

function renderSamples(container) {
  SAMPLE_QUESTIONS.forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sample";
    b.textContent = q;
    b.addEventListener("click", () => sendQuestion(q));
    container.append(b);
  });
}

TOPICS.forEach((t) => {
  const c = document.createElement("span");
  c.className = "chip";
  c.textContent = t;
  els.topics.append(c);
});
renderSamples(els.samples);
renderSamples(els.emptySamples);

els.sendBtn.addEventListener("click", () => sendQuestion(els.input.value));
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendQuestion(els.input.value);
  }
});
els.input.addEventListener("input", autoGrow);
els.clearBtn.addEventListener("click", clearChat);
els.menuBtn.addEventListener("click", () => els.sidebar.classList.toggle("open"));

checkHealth();
setInterval(checkHealth, 30000);
els.input.focus();
