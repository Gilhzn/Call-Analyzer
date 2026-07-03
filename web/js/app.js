"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  banner: $("banner"),
  uploadSection: $("upload-section"),
  dropZone: $("drop-zone"),
  fileInput: $("file-input"),
  modelSelect: $("model-select"),
  progressSection: $("progress-section"),
  progressStage: $("progress-stage"),
  progressElapsed: $("progress-elapsed"),
  progressDetail: $("progress-detail"),
  progressBarWrap: $("progress-bar-wrap"),
  progressBar: $("progress-bar"),
  cancelBtn: $("cancel-btn"),
  resultsSection: $("results-section"),
  transcriptBody: $("transcript-body"),
  analysisBody: $("analysis-body"),
  copyTranscript: $("copy-transcript"),
  copyAnalysis: $("copy-analysis"),
  resetRow: $("reset-row"),
  resetBtn: $("reset-btn"),
};

const LLM_MODEL = "gemma-2-2b-it-q4f16_1-MLC";
const MAX_ANALYSIS_CHARS = 6000;

const SYSTEM_PROMPT = `אתה אנליסט עסקי מומחה. תקבל תמליל של שיחה עסקית מוקלטת. נתח אותה ביסודיות והשב בעברית בלבד.

השב אך ורק באובייקט JSON תקין במבנה הבא:
{
  "summary": "פסקת סיכום עסקית תמציתית של השיחה",
  "key_points": ["נקודה עסקית חשובה", "כולל שמות, סכומים ותאריכים שהוזכרו"],
  "action_items": [{"task": "משימה לביצוע", "owner": "נציג / לקוח / לא ידוע", "due": "מועד יעד אם הוזכר, אחרת מחרוזת ריקה"}],
  "participants": "אפיון הדוברים: מי הם ותפקידם",
  "sentiment": "חיובי / ניטרלי / שלילי / מעורב",
  "topics": ["נושא מרכזי"]
}

כללים: השב ב-JSON תקין בלבד, ללא טקסט לפני או אחרי. כל הערכים בעברית. אם מידע חסר — מחרוזת ריקה או רשימה ריקה. אל תמציא פרטים.`;

const state = {
  worker: null,
  llmEngine: null,
  segments: [],
  analysis: null,
  timerId: null,
  startedAt: null,
  cancelled: false,
};

/* ===== Capability banner ===== */
const hasWebGPU = !!navigator.gpu;
if (!hasWebGPU) {
  showBanner(
    "warning",
    "הדפדפן הזה לא תומך ב-WebGPU, ולכן יופק תמליל בלבד ללא ניתוח עסקי. לניתוח מלא השתמשו ב-Chrome או Edge עדכניים במחשב, או הריצו את הגרסה המקומית."
  );
}

function showBanner(kind, text) {
  els.banner.className = `banner ${kind}`;
  els.banner.textContent = text;
}

function hideBanner() {
  els.banner.className = "banner hidden";
  els.banner.textContent = "";
  if (!hasWebGPU) {
    showBanner("warning", "הדפדפן הזה לא תומך ב-WebGPU — יופק תמליל בלבד ללא ניתוח עסקי.");
  }
}

/* ===== Upload wiring ===== */
els.dropZone.addEventListener("click", () => els.fileInput.click());
els.dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files.length) run(els.fileInput.files[0]);
});
["dragenter", "dragover"].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => { e.preventDefault(); els.dropZone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => { e.preventDefault(); els.dropZone.classList.remove("dragover"); })
);
els.dropZone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files.length) run(e.dataTransfer.files[0]);
});

els.cancelBtn.addEventListener("click", () => {
  state.cancelled = true;
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  stopTimer();
  resetUI();
});
els.resetBtn.addEventListener("click", resetUI);

/* ===== Main flow ===== */
async function run(file) {
  resetState();
  state.cancelled = false;
  els.uploadSection.classList.add("hidden");
  els.progressSection.classList.remove("hidden");
  els.resultsSection.classList.remove("hidden");
  startTimer();

  try {
    setStage("קורא ומפענח את קובץ השמע…");
    const audio = await decodeAudio(file);

    setStage("טוען את מודל התמלול (הורדה חד-פעמית, נשמר במטמון)…");
    const segments = await transcribe(audio);
    if (state.cancelled) return;

    state.segments = segments;
    els.transcriptBody.replaceChildren();
    if (!segments.length) {
      renderPanelError(els.transcriptBody, "לא זוהה דיבור בהקלטה.");
      finish();
      return;
    }
    segments.forEach(appendSegment);
    els.copyTranscript.disabled = false;

    if (!hasWebGPU) {
      renderPanelError(els.analysisBody, "ניתוח עסקי אינו זמין בדפדפן זה (אין תמיכת WebGPU). התמליל המלא זמין להעתקה.");
      finish();
      return;
    }

    setStage("טוען את מודל הניתוח (הורדה חד-פעמית של כ-1.4GB בפעם הראשונה)…");
    showAnalysisSkeleton();
    const analysis = await analyze(segments);
    if (state.cancelled) return;

    state.analysis = analysis;
    renderAnalysis(analysis);
    els.copyAnalysis.disabled = false;
    finish();
  } catch (err) {
    if (state.cancelled) return;
    console.error(err);
    if (!state.segments.length) {
      renderPanelError(els.transcriptBody, "התמלול נכשל: " + friendlyError(err));
      renderPanelError(els.analysisBody, "הניתוח לא הופק כי התמלול נכשל.");
    } else {
      renderPanelError(els.analysisBody, "הניתוח נכשל: " + friendlyError(err) + " התמליל המלא זמין להעתקה.");
    }
    finish();
  }
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/fetch|network|Failed to load|import/i.test(msg)) {
    return "בעיית רשת בהורדת המודל — בדקו את החיבור לאינטרנט ונסו שוב.";
  }
  if (/decode/i.test(msg)) {
    return "לא ניתן לפענח את קובץ השמע — ודאו שזה קובץ הקלטה תקין.";
  }
  return msg;
}

function finish() {
  stopTimer();
  els.progressSection.classList.add("hidden");
  els.resetRow.classList.remove("hidden");
}

/* ===== Audio decode (16kHz mono Float32) ===== */
async function decodeAudio(file) {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    if (audioBuffer.numberOfChannels === 1) {
      return audioBuffer.getChannelData(0);
    }
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);
    const mono = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
    return mono;
  } finally {
    ctx.close();
  }
}

/* ===== Transcription via worker ===== */
function transcribe(audio) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("js/asr-worker.js", { type: "module" });
    state.worker = worker;
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "download") {
        setStage("מוריד את מודל התמלול (חד-פעמי)…");
        setDetail(msg.file || "");
        setProgressBar(msg.progress);
      } else if (msg.type === "stage" && msg.stage === "transcribing") {
        setStage("מתמלל את השיחה… (זה יכול לקחת כמה דקות, לפי אורך ההקלטה)");
        setDetail("");
        setProgressBar(null);
      } else if (msg.type === "result") {
        worker.terminate();
        state.worker = null;
        resolve(msg.segments);
      } else if (msg.type === "error") {
        worker.terminate();
        state.worker = null;
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      state.worker = null;
      reject(new Error(e.message || "worker error"));
    };
    worker.postMessage(
      { type: "transcribe", audio, model: els.modelSelect.value },
      [audio.buffer]
    );
  });
}

/* ===== Analysis via WebLLM ===== */
async function analyze(segments) {
  const webllm = await import("https://esm.run/@mlc-ai/web-llm");

  if (!state.llmEngine) {
    state.llmEngine = await webllm.CreateMLCEngine(LLM_MODEL, {
      initProgressCallback: (report) => {
        setDetail(report.text || "");
        if (typeof report.progress === "number") setProgressBar(Math.round(report.progress * 100));
      },
    });
  }

  setStage("מנתח ומסכם את השיחה…");
  setDetail("");
  setProgressBar(null);

  let transcript = state.segments.map((s) => `[${formatTs(s.start)}] ${s.text}`).join("\n");
  let truncated = false;
  if (transcript.length > MAX_ANALYSIS_CHARS) {
    transcript = transcript.slice(0, MAX_ANALYSIS_CHARS);
    truncated = true;
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `תמליל השיחה (עם חותמות זמן):\n\n${transcript}` },
  ];

  let raw;
  try {
    const resp = await state.llmEngine.chat.completions.create({
      messages, temperature: 0.2, response_format: { type: "json_object" },
    });
    raw = resp.choices[0].message.content;
  } catch {
    const resp = await state.llmEngine.chat.completions.create({ messages, temperature: 0.2 });
    raw = resp.choices[0].message.content;
  }

  const parsed = parseAnalysisJson(raw);
  if (!parsed) {
    return { summary: (raw || "").trim(), key_points: [], action_items: [], participants: "", sentiment: "", topics: [], meta: { degraded: true, truncated } };
  }
  parsed.meta = { truncated, degraded: false };
  return normalizeAnalysis(parsed);
}

function parseAnalysisJson(raw) {
  if (!raw || !raw.trim()) return null;
  const text = raw.trim();
  const candidates = [text];
  const fenced = text.replace(/^```(?:json)?\s*|\s*```$/gm, "").trim();
  if (fenced !== text) candidates.push(fenced);
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* try next */ }
  }
  return null;
}

function normalizeAnalysis(a) {
  const str = (v) => (v == null ? "" : Array.isArray(v) ? v.map(String).join(" ") : String(v).trim());
  const strList = (v) => {
    if (!v) return [];
    if (typeof v === "string") return v.trim() ? [v.trim()] : [];
    if (!Array.isArray(v)) return [String(v)];
    return v.map((item) => (item && typeof item === "object" ? Object.values(item).map(String).join(" ") : String(item).trim())).filter(Boolean);
  };
  return {
    summary: str(a.summary),
    key_points: strList(a.key_points),
    action_items: (Array.isArray(a.action_items) ? a.action_items : [])
      .map((item) => (typeof item === "string" ? { task: item, owner: "", due: "" } : { task: str(item?.task), owner: str(item?.owner), due: str(item?.due) }))
      .filter((item) => item.task),
    participants: str(a.participants),
    sentiment: str(a.sentiment),
    topics: strList(a.topics),
    meta: a.meta || {},
  };
}

/* ===== Rendering (shared with the local app's UI) ===== */
function placeholderEl(text) {
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = text;
  return p;
}

function formatTs(seconds) {
  const t = Math.floor(seconds || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function appendSegment(seg) {
  const row = document.createElement("div");
  row.className = "seg";
  const ts = document.createElement("bdi");
  ts.className = "ts";
  ts.textContent = `[${formatTs(seg.start)}]`;
  const text = document.createElement("span");
  text.textContent = seg.text;
  row.append(ts, text);
  els.transcriptBody.appendChild(row);
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
      const bits = [];
      if (item.owner) bits.push(`אחראי: ${item.owner}`);
      if (item.due) bits.push(`מועד: ${item.due}`);
      if (bits.length) {
        const meta = document.createElement("div");
        meta.className = "meta-line";
        meta.textContent = bits.join(" · ");
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
  if (!frag.childNodes.length) frag.appendChild(placeholderEl("המודל לא החזיר תוכן ניתוח."));

  if (a.meta?.truncated) {
    const note = document.createElement("div");
    note.className = "analysis-note";
    note.textContent = "השיחה ארוכה — הניתוח מבוסס על חלקה הראשון. לניתוח מלא השתמשו בגרסה המקומית.";
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

function renderPanelError(panel, message) {
  const box = document.createElement("div");
  box.className = "panel-error";
  box.textContent = message;
  panel.replaceChildren(box);
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
function setStage(text) { els.progressStage.textContent = text; }
function setDetail(text) { els.progressDetail.textContent = text; }
function setProgressBar(percent) {
  if (percent == null) {
    els.progressBarWrap.classList.add("hidden");
  } else {
    els.progressBarWrap.classList.remove("hidden");
    els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
}

function startTimer() {
  state.startedAt = Date.now();
  els.progressElapsed.textContent = "00:00";
  state.timerId = setInterval(() => {
    els.progressElapsed.textContent = formatTs((Date.now() - state.startedAt) / 1000);
  }, 1000);
}
function stopTimer() {
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
}

/* ===== Reset ===== */
function resetState() {
  state.segments = [];
  state.analysis = null;
  els.transcriptBody.replaceChildren(placeholderEl("התמליל יופיע כאן…"));
  els.analysisBody.replaceChildren(placeholderEl("הניתוח והסיכום יופיעו כאן לאחר התמלול…"));
  els.copyTranscript.disabled = true;
  els.copyAnalysis.disabled = true;
  setDetail("");
  setProgressBar(null);
  hideBanner();
}

function resetUI() {
  resetState();
  els.fileInput.value = "";
  els.resultsSection.classList.add("hidden");
  els.progressSection.classList.add("hidden");
  els.resetRow.classList.add("hidden");
  els.uploadSection.classList.remove("hidden");
}
