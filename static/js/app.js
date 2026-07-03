"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  banner: $("banner"),
  uploadSection: $("upload-section"),
  dropZone: $("drop-zone"),
  fileInput: $("file-input"),
  progressSection: $("progress-section"),
  progressStage: $("progress-stage"),
  progressElapsed: $("progress-elapsed"),
  progressPercent: $("progress-percent"),
  progressBarWrap: $("progress-bar-wrap"),
  progressBar: $("progress-bar"),
  languageChip: $("language-chip"),
  cancelBtn: $("cancel-btn"),
  resultsSection: $("results-section"),
  transcriptBody: $("transcript-body"),
  analysisBody: $("analysis-body"),
  copyTranscript: $("copy-transcript"),
  copyAnalysis: $("copy-analysis"),
  resetRow: $("reset-row"),
  resetBtn: $("reset-btn"),
  maxSize: $("max-size"),
};

const LANG_NAMES = { he: "עברית", en: "אנגלית", ar: "ערבית", ru: "רוסית", fr: "צרפתית", es: "ספרדית", de: "גרמנית", yi: "יידיש" };

const state = {
  eventSource: null,
  segments: [],
  analysis: null,
  timerId: null,
  startedAt: null,
  duration: 0,
  jobId: null,
  lastEventId: -1,
};

/* ===== Session persistence =====
   Mobile browsers kill background tabs; the transcript/analysis so far and
   the job id are saved locally, and on reload the page reconnects to the
   server stream from the exact event where it stopped. */
const STORAGE_KEY = "call-analyzer-session";
let saveTimer = null;

function saveSession(patch = {}) {
  try {
    const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...current,
      jobId: state.jobId,
      lastEventId: state.lastEventId,
      duration: state.duration,
      segments: state.segments,
      analysis: state.analysis,
      savedAt: Date.now(),
      ...patch,
    }));
  } catch { /* storage full/unavailable — resume just won't be possible */ }
}

function saveSessionThrottled() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveSession(); }, 800);
}

function clearSession() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { return null; }
}

async function tryRestoreSession() {
  const saved = loadSession();
  if (!saved || !saved.stage) return;

  const showResults = () => {
    els.uploadSection.classList.add("hidden");
    els.resultsSection.classList.remove("hidden");
    state.segments = saved.segments || [];
    state.duration = saved.duration || 0;
    els.transcriptBody.replaceChildren();
    state.segments.forEach(appendSegment);
    els.copyTranscript.disabled = state.segments.length === 0;
    if (saved.analysis) {
      state.analysis = saved.analysis;
      renderAnalysis(saved.analysis);
      els.copyAnalysis.disabled = false;
    }
  };

  if (saved.stage === "done") {
    showResults();
    els.resetRow.classList.remove("hidden");
    showBanner("info", "שוחזרו התוצאות מהניתוח האחרון. לניתוח חדש לחצו על \"ניתוח שיחה חדשה\".");
    return;
  }

  // Mid-job: check the job still exists on the server, then re-attach to the
  // stream from the last event we already received.
  let alive = false;
  try {
    const res = await fetch(`/api/jobs/${saved.jobId}`);
    alive = res.ok;
  } catch { alive = false; }

  showResults();
  if (!alive) {
    els.resetRow.classList.remove("hidden");
    if (state.segments.length) {
      renderAnalysisError("החיבור לעיבוד אבד (העבודה כבר לא זמינה בשרת). התמליל ששוחזר זמין להעתקה — לניתוח מלא העלו את הקובץ שוב.");
      showBanner("warning", "התמליל שוחזר, אך העיבוד בשרת הסתיים או פג תוקפו.");
    } else {
      clearSession();
      resetUI();
    }
    return;
  }

  state.jobId = saved.jobId;
  state.lastEventId = saved.lastEventId ?? -1;
  els.progressSection.classList.remove("hidden");
  setStage("ממשיך מהנקודה שבה נעצר…");
  showBanner("info", "השיחה שוחזרה — ממשיך מהנקודה שבה נעצר.");
  startTimer();
  listen(saved.jobId, state.lastEventId);
}

/* ===== Health banner ===== */
async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    const health = await res.json();
    if (!health.ollama.reachable) {
      showBanner(
        "warning",
        "שירות Ollama אינו פעיל — התמלול יעבוד, אך הניתוח העסקי לא יופק. הפעילו אותו עם הפקודה ",
        "ollama serve"
      );
    } else if (!health.ollama.model_available) {
      showBanner(
        "warning",
        `מודל הניתוח "${health.ollama.model}" אינו מותקן ב-Ollama. התקינו אותו עם הפקודה `,
        `ollama pull ${health.ollama.model}`
      );
    } else if (els.banner.classList.contains("warning")) {
      // Clear only our own health warning — never a restore/info banner.
      hideBanner();
    }
  } catch {
    /* server unreachable — the upload itself will surface the error */
  }
}

function showBanner(kind, text, command) {
  els.banner.className = `banner ${kind}`;
  els.banner.textContent = text;
  if (command) {
    const code = document.createElement("code");
    code.textContent = command;
    els.banner.appendChild(code);
  }
}

function hideBanner() {
  els.banner.className = "banner hidden";
  els.banner.textContent = "";
}

/* ===== Upload ===== */
els.dropZone.addEventListener("click", () => els.fileInput.click());
els.dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files.length) upload(els.fileInput.files[0]);
});

["dragenter", "dragover"].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => { e.preventDefault(); els.dropZone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => { e.preventDefault(); els.dropZone.classList.remove("dragover"); })
);
els.dropZone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files.length) upload(e.dataTransfer.files[0]);
});

async function upload(file) {
  const maxMb = parseInt(els.maxSize.textContent, 10) || 200;
  if (file.size > maxMb * 1024 * 1024) {
    showBanner("error", `הקובץ גדול מדי — הגודל המרבי הוא ${maxMb}MB.`);
    return;
  }

  clearSession();
  resetState();
  els.uploadSection.classList.add("hidden");
  els.progressSection.classList.remove("hidden");
  setStage("מעלה את הקובץ…");
  startTimer();

  const form = new FormData();
  form.append("file", file);

  let jobId;
  try {
    const res = await fetch("/api/analyze", { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail?.message || "העלאת הקובץ נכשלה. נסו שוב.");
    }
    jobId = (await res.json()).job_id;
  } catch (err) {
    failEarly(err.message || "העלאת הקובץ נכשלה. נסו שוב.");
    return;
  }

  els.resultsSection.classList.remove("hidden");
  setStage("מכין את מנוע התמלול…");
  state.jobId = jobId;
  state.lastEventId = -1;
  saveSession({ stage: "processing" });
  listen(jobId);
}

function failEarly(message) {
  stopTimer();
  els.progressSection.classList.add("hidden");
  els.uploadSection.classList.remove("hidden");
  showBanner("error", message);
}

/* ===== SSE ===== */
function listen(jobId, after = -1) {
  const url = `/api/jobs/${jobId}/stream` + (after >= 0 ? `?after=${after}` : "");
  const es = new EventSource(url);
  state.eventSource = es;

  const track = (e) => {
    const id = parseInt(e.lastEventId, 10);
    if (!Number.isNaN(id)) state.lastEventId = id;
  };

  es.addEventListener("status", (e) => {
    track(e);
    const data = JSON.parse(e.data);
    switch (data.stage) {
      case "queued":
        setStage("ממתין בתור — שיחה אחרת מעובדת כעת…");
        break;
      case "loading_model":
        setStage("טוען את מודל התמלול (בפעם הראשונה זה עשוי לקחת מספר דקות)…");
        break;
      case "transcribing":
        setStage("מתמלל את השיחה…");
        state.duration = data.duration || 0;
        setProgressBar(0);
        if (data.language) {
          const name = LANG_NAMES[data.language] || data.language;
          els.languageChip.textContent = `שפה מזוהה: ${name}`;
          els.languageChip.classList.remove("hidden");
        }
        break;
      case "analyzing":
        setStage(data.chunks ? `מנתח את השיחה… (חלק ${data.chunk} מתוך ${data.chunks})` : "מנתח ומסכם את השיחה…");
        setProgressBar(data.chunks ? Math.round((data.chunk / data.chunks) * 100) : null);
        showAnalysisSkeleton();
        break;
    }
  });

  es.addEventListener("segment", (e) => {
    track(e);
    const seg = JSON.parse(e.data);
    state.segments.push(seg);
    appendSegment(seg);
    if (state.duration) {
      setProgressBar(Math.min(99, Math.round((seg.end / state.duration) * 100)));
    }
    saveSessionThrottled();
  });

  es.addEventListener("transcript_done", (e) => {
    track(e);
    els.copyTranscript.disabled = state.segments.length === 0;
    setProgressBar(100);
    saveSession();
  });

  es.addEventListener("analysis", (e) => {
    track(e);
    state.analysis = JSON.parse(e.data);
    renderAnalysis(state.analysis);
    els.copyAnalysis.disabled = false;
    saveSession();
  });

  es.addEventListener("error", (e) => {
    // Custom server "error" events carry data; transport errors do not
    // (EventSource reconnects those automatically with Last-Event-ID).
    if (e.data) {
      track(e);
      const data = JSON.parse(e.data);
      renderAnalysisError(data.message);
      finishJob();
    }
  });

  es.addEventListener("done", (e) => {
    track(e);
    finishJob();
  });
}

function finishJob() {
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  stopTimer();
  saveSession({ stage: "done" });
  els.progressSection.classList.add("hidden");
  els.resetRow.classList.remove("hidden");
}

els.cancelBtn.addEventListener("click", () => {
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  stopTimer();
  clearSession();
  resetUI();
});

els.resetBtn.addEventListener("click", () => {
  clearSession();
  resetUI();
});

function resetState() {
  state.segments = [];
  state.analysis = null;
  state.jobId = null;
  state.lastEventId = -1;
  hideBanner();
  els.transcriptBody.replaceChildren(placeholderEl("התמליל יופיע כאן בזמן אמת…"));
  els.analysisBody.replaceChildren(placeholderEl("הניתוח והסיכום יופיעו כאן לאחר התמלול…"));
  els.copyTranscript.disabled = false;
  els.copyAnalysis.disabled = true;
  els.languageChip.classList.add("hidden");
  state.duration = 0;
  setProgressBar(null);
}

function resetUI() {
  resetState();
  els.fileInput.value = "";
  els.resultsSection.classList.add("hidden");
  els.progressSection.classList.add("hidden");
  els.resetRow.classList.add("hidden");
  els.uploadSection.classList.remove("hidden");
  checkHealth();
}

/* ===== Rendering ===== */
function placeholderEl(text) {
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = text;
  return p;
}

function formatTs(seconds) {
  const t = Math.floor(seconds);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function appendSegment(seg) {
  const ph = els.transcriptBody.querySelector(".placeholder");
  if (ph) ph.remove();

  const row = document.createElement("div");
  row.className = "seg";
  const ts = document.createElement("bdi");
  ts.className = "ts";
  ts.textContent = `[${formatTs(seg.start)}]`;
  const text = document.createElement("span");
  text.textContent = seg.text;
  row.append(ts, text);
  els.transcriptBody.appendChild(row);

  // Autoscroll only if the user is already near the bottom.
  const nearBottom = els.transcriptBody.scrollHeight - els.transcriptBody.scrollTop - els.transcriptBody.clientHeight < 120;
  if (nearBottom) els.transcriptBody.scrollTop = els.transcriptBody.scrollHeight;
}

function showAnalysisSkeleton() {
  const wrap = document.createElement("div");
  wrap.className = "skeleton";
  ["", "w80", "w60", "", "w80"].forEach((w) => {
    const bone = document.createElement("div");
    bone.className = `bone ${w}`.trim();
    wrap.appendChild(bone);
  });
  els.analysisBody.replaceChildren(wrap);
}

function sectionEl(title, contentEl) {
  const section = document.createElement("div");
  section.className = "analysis-section";
  const h = document.createElement("h3");
  h.textContent = title;
  section.append(h, contentEl);
  return section;
}

function renderAnalysis(a) {
  const frag = document.createDocumentFragment();

  if (a.summary) {
    const p = document.createElement("p");
    p.textContent = a.summary;
    frag.appendChild(sectionEl("סיכום השיחה", p));
  }

  if (a.key_points?.length) {
    const ul = document.createElement("ul");
    a.key_points.forEach((point) => {
      const li = document.createElement("li");
      li.textContent = point;
      ul.appendChild(li);
    });
    frag.appendChild(sectionEl("נקודות חשובות", ul));
  }

  if (a.action_items?.length) {
    const ul = document.createElement("ul");
    a.action_items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "action-item";
      li.textContent = item.task;
      const metaBits = [];
      if (item.owner) metaBits.push(`אחראי: ${item.owner}`);
      if (item.due) metaBits.push(`מועד: ${item.due}`);
      if (metaBits.length) {
        const meta = document.createElement("div");
        meta.className = "meta-line";
        meta.textContent = metaBits.join(" · ");
        li.appendChild(meta);
      }
      ul.appendChild(li);
    });
    frag.appendChild(sectionEl("משימות להמשך", ul));
  }

  if (a.participants) {
    const p = document.createElement("p");
    p.textContent = a.participants;
    frag.appendChild(sectionEl("משתתפים", p));
  }

  if (a.sentiment) {
    const chip = document.createElement("span");
    chip.className = "sentiment-chip";
    if (a.sentiment.includes("חיובי")) chip.classList.add("pos");
    else if (a.sentiment.includes("שלילי")) chip.classList.add("neg");
    else if (a.sentiment.includes("מעורב")) chip.classList.add("mixed");
    chip.textContent = a.sentiment;
    frag.appendChild(sectionEl("סנטימנט", chip));
  }

  if (a.topics?.length) {
    const row = document.createElement("div");
    row.className = "topics-row";
    a.topics.forEach((topic) => {
      const chip = document.createElement("span");
      chip.className = "topic-chip";
      chip.textContent = topic;
      row.appendChild(chip);
    });
    frag.appendChild(sectionEl("נושאים", row));
  }

  if (!frag.childNodes.length) {
    frag.appendChild(placeholderEl("המודל לא החזיר תוכן ניתוח."));
  }

  if (a.meta?.truncated) {
    const note = document.createElement("div");
    note.className = "analysis-note";
    note.textContent = "השיחה ארוכה מאוד — הניתוח מבוסס על חלקה העיקרי.";
    frag.appendChild(note);
  }
  if (a.meta?.degraded) {
    const note = document.createElement("div");
    note.className = "analysis-note";
    note.textContent = "המודל לא החזיר מבנה מלא — מוצג הסיכום הגולמי בלבד.";
    frag.appendChild(note);
  }

  els.analysisBody.replaceChildren(frag);
}

function renderAnalysisError(message) {
  const box = document.createElement("div");
  box.className = "panel-error";
  box.textContent = message;
  els.analysisBody.replaceChildren(box);
}

/* ===== Copy ===== */
function transcriptAsText() {
  return state.segments.map((s) => `[${formatTs(s.start)}] ${s.text}`).join("\n");
}

function analysisAsText() {
  const a = state.analysis;
  if (!a) return "";
  const lines = [];
  if (a.summary) lines.push("סיכום השיחה:", a.summary, "");
  if (a.key_points?.length) {
    lines.push("נקודות חשובות:");
    a.key_points.forEach((p) => lines.push(`• ${p}`));
    lines.push("");
  }
  if (a.action_items?.length) {
    lines.push("משימות להמשך:");
    a.action_items.forEach((item) => {
      let line = `• ${item.task}`;
      const bits = [];
      if (item.owner) bits.push(`אחראי: ${item.owner}`);
      if (item.due) bits.push(`מועד: ${item.due}`);
      if (bits.length) line += ` (${bits.join(", ")})`;
      lines.push(line);
    });
    lines.push("");
  }
  if (a.participants) lines.push(`משתתפים: ${a.participants}`);
  if (a.sentiment) lines.push(`סנטימנט: ${a.sentiment}`);
  if (a.topics?.length) lines.push(`נושאים: ${a.topics.join(", ")}`);
  return lines.join("\n").trim();
}

function wireCopy(button, getText) {
  button.addEventListener("click", async () => {
    const text = getText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API requires a secure context — fall back to a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    const label = button.querySelector("span");
    const original = label.textContent;
    label.textContent = "הועתק ✓";
    button.classList.add("copied");
    setTimeout(() => {
      label.textContent = original;
      button.classList.remove("copied");
    }, 1500);
  });
}

wireCopy(els.copyTranscript, transcriptAsText);
wireCopy(els.copyAnalysis, analysisAsText);

/* ===== Progress helpers ===== */
function setStage(text) {
  els.progressStage.textContent = text;
}

function setProgressBar(percent) {
  if (percent == null) {
    els.progressBarWrap.classList.add("hidden");
    els.progressPercent.textContent = "";
  } else {
    const clamped = Math.max(0, Math.min(100, percent));
    els.progressBarWrap.classList.remove("hidden");
    els.progressBar.style.width = `${clamped}%`;
    els.progressPercent.textContent = `${clamped}%`;
  }
}

function startTimer() {
  state.startedAt = Date.now();
  els.progressElapsed.textContent = "00:00";
  state.timerId = setInterval(() => {
    const sec = Math.floor((Date.now() - state.startedAt) / 1000);
    els.progressElapsed.textContent = formatTs(sec);
  }, 1000);
}

function stopTimer() {
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
}

/* ===== Init ===== */
checkHealth();
tryRestoreSession();
