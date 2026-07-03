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
  progressPercent: $("progress-percent"),
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
  enginePromise: null,
  segments: [],
  analysis: null,
  timerId: null,
  startedAt: null,
  cancelled: false,
  stage: "idle",
  // Session-resume bookkeeping (survives the tab being killed in background)
  sourceFile: null,
  totalDuration: 0,
  priorSegments: [],
  completedChunks: [],
  wakeLock: null,
};

/* ===== Durable session store (IndexedDB) =====
   Mobile browsers discard background tabs; everything needed to continue —
   the audio file, completed transcript chunks and the analysis — is saved
   here so a reload resumes from the exact spot instead of starting over. */
const DB_NAME = "call-analyzer";
const DB_STORE = "session";
const SESSION_KEY = "current";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function sessionSave(patch) {
  try {
    const db = await openDb();
    const existing = await new Promise((resolve) => {
      const rq = db.transaction(DB_STORE).objectStore(DB_STORE).get(SESSION_KEY);
      rq.onsuccess = () => resolve(rq.result || {});
      rq.onerror = () => resolve({});
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put({ ...existing, ...patch, savedAt: Date.now() }, SESSION_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* storage unavailable — continue without resume support */ }
}

async function sessionLoad() {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const rq = db.transaction(DB_STORE).objectStore(DB_STORE).get(SESSION_KEY);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function sessionClear() {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(SESSION_KEY);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  } catch { /* ignore */ }
}

/* ===== Screen wake lock — keeps the phone from sleeping mid-processing ===== */
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
    } else if (!on && state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch { /* not supported / denied — non-fatal */ }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" &&
      ["asr", "llm", "analyzing"].includes(state.stage)) {
    keepAwake(true);
  }
});

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
  keepAwake(false);
  sessionClear();
  resetUI();
});
els.resetBtn.addEventListener("click", () => {
  sessionClear();
  resetUI();
});

/* ===== Main flow ===== */
async function run(file, restore = null) {
  resetState();
  state.cancelled = false;
  state.sourceFile = file;
  state.priorSegments = restore?.doneSegments || [];
  state.completedChunks = [];
  els.uploadSection.classList.add("hidden");
  els.progressSection.classList.remove("hidden");
  els.resultsSection.classList.remove("hidden");
  startTimer();
  keepAwake(true);
  if (restore) {
    showBanner("info", `השיחה שוחזרה — ממשיך בתמלול מהנקודה שבה נעצר (${formatTs(restore.processedSec || 0)}).`);
  }

  try {
    setStage("קורא ומפענח את קובץ השמע…");
    const fullAudio = await decodeAudio(file);
    state.totalDuration = fullAudio.length / 16000;

    const baseOffset = Math.min(restore?.processedSec || 0, state.totalDuration);
    const audio = baseOffset > 0 ? fullAudio.slice(Math.floor(baseOffset * 16000)) : fullAudio;

    if (state.priorSegments.length) {
      els.transcriptBody.replaceChildren();
      state.priorSegments.forEach(appendSegment);
    }

    if (!restore) {
      await sessionClear();
    }
    sessionSave({
      stage: "transcribing",
      file,
      fileName: file.name,
      model: els.modelSelect.value,
      processedSec: baseOffset,
      doneSegments: state.priorSegments,
    });

    // Speed: start downloading/compiling the analysis model in parallel with
    // the transcription instead of after it.
    preloadLLM();

    setStage("טוען את מודל התמלול (הורדה חד-פעמית, נשמר במטמון)…");
    const newSegments = await transcribe(audio, baseOffset);
    if (state.cancelled) return;

    const segments = [...state.priorSegments, ...newSegments];
    await finishTranscript(segments);
  } catch (err) {
    handleRunError(err);
  }
}

async function finishTranscript(segments) {
  state.stage = "asr_done";
  state.segments = segments;
  els.transcriptBody.replaceChildren();
  if (!segments.length) {
    renderPanelError(els.transcriptBody, "לא זוהה דיבור בהקלטה.");
    sessionClear();
    finish();
    return;
  }
  segments.forEach(appendSegment);
  els.copyTranscript.disabled = false;

  if (!hasWebGPU) {
    renderPanelError(els.analysisBody, "ניתוח עסקי אינו זמין בדפדפן זה (אין תמיכת WebGPU). התמליל המלא זמין להעתקה.");
    sessionSave({ stage: "done", file: null, segments, analysis: null, doneSegments: [] });
    finish();
    return;
  }

  // Transcript is safe — the audio is no longer needed for resume.
  sessionSave({ stage: "analyzing", file: null, segments, doneSegments: [] });
  await runAnalysisStage(segments);
}

async function runAnalysisStage(segments) {
  try {
    state.stage = "llm";
    setStage("טוען את מודל הניתוח (הורדה חד-פעמית, נשמר במטמון)…");
    showAnalysisSkeleton();
    const analysis = await analyze(segments);
    if (state.cancelled) return;

    state.analysis = analysis;
    renderAnalysis(analysis);
    els.copyAnalysis.disabled = false;
    sessionSave({ stage: "done", analysis });
    finish();
  } catch (err) {
    handleRunError(err);
  }
}

function handleRunError(err) {
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

/* ===== Resume after the tab was killed or the page reloaded ===== */
async function tryRestoreSession() {
  const saved = await sessionLoad();
  if (!saved || !saved.stage) return;

  if (saved.stage === "done" && saved.segments?.length) {
    els.uploadSection.classList.add("hidden");
    els.resultsSection.classList.remove("hidden");
    els.resetRow.classList.remove("hidden");
    state.segments = saved.segments;
    els.transcriptBody.replaceChildren();
    saved.segments.forEach(appendSegment);
    els.copyTranscript.disabled = false;
    if (saved.analysis) {
      state.analysis = saved.analysis;
      renderAnalysis(saved.analysis);
      els.copyAnalysis.disabled = false;
    }
    showBanner("info", "שוחזרו התוצאות מהניתוח האחרון. לניתוח חדש לחצו על \"ניתוח שיחה חדשה\".");
    return;
  }

  if (saved.stage === "analyzing" && saved.segments?.length) {
    els.uploadSection.classList.add("hidden");
    els.progressSection.classList.remove("hidden");
    els.resultsSection.classList.remove("hidden");
    state.segments = saved.segments;
    els.transcriptBody.replaceChildren();
    saved.segments.forEach(appendSegment);
    els.copyTranscript.disabled = false;
    showBanner("info", "השיחה שוחזרה — ממשיך בניתוח מהנקודה שבה נעצר.");
    startTimer();
    keepAwake(true);
    if (hasWebGPU) preloadLLM();
    await runAnalysisStage(saved.segments);
    return;
  }

  if (saved.stage === "transcribing" && saved.file) {
    if (saved.model) els.modelSelect.value = saved.model;
    await run(saved.file, {
      processedSec: saved.processedSec || 0,
      doneSegments: saved.doneSegments || [],
    });
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
  state.stage = "done";
  stopTimer();
  keepAwake(false);
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
function transcribe(audio, baseOffset = 0) {
  const duration = audio.length / 16000;
  const total = state.totalDuration || (baseOffset + duration);
  return new Promise((resolve, reject) => {
    const worker = new Worker("js/asr-worker.js", { type: "module" });
    state.worker = worker;
    state.stage = "asr";
    let lastPartial = null;
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "download") {
        setStage("מוריד את מודל התמלול (חד-פעמי)…");
        setProgressBar(msg.percent);
      } else if (msg.type === "stage" && msg.stage === "transcribing") {
        setStage(msg.device === "webgpu" ? "מתמלל את השיחה… (מואץ GPU)" : "מתמלל את השיחה…");
        setProgressBar(total ? Math.round((baseOffset / total) * 100) : 0);
      } else if (msg.type === "progress") {
        const absSec = baseOffset + (msg.percent / 100) * duration;
        setProgressBar(Math.min(99, Math.round((absSec / total) * 100)));
      } else if (msg.type === "partial") {
        const absStart = msg.start + baseOffset;
        if (lastPartial && absStart !== lastPartial.start && lastPartial.text.trim()) {
          // A chunk just finished — checkpoint it so a killed tab resumes here.
          state.completedChunks.push({ start: lastPartial.start, end: absStart, text: lastPartial.text.trim() });
          sessionSave({
            processedSec: absStart,
            doneSegments: [...state.priorSegments, ...state.completedChunks],
          });
        }
        lastPartial = { start: absStart, text: msg.text };
        renderPartialSegment(absStart, msg.text);
      } else if (msg.type === "result") {
        setProgressBar(100);
        worker.terminate();
        state.worker = null;
        resolve(msg.segments.map((s) => ({
          start: s.start + baseOffset,
          end: s.end + baseOffset,
          text: s.text,
        })));
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
      { type: "transcribe", audio, model: els.modelSelect.value, duration },
      [audio.buffer]
    );
  });
}

// Live text of the chunk whisper is currently decoding.
function renderPartialSegment(start, text) {
  if (!text.trim()) return;
  const ph = els.transcriptBody.querySelector(".placeholder");
  if (ph) ph.remove();

  let live = els.transcriptBody.querySelector(`.seg.live[data-start="${start}"]`);
  if (!live) {
    els.transcriptBody.querySelectorAll(".seg.live").forEach((el) => el.classList.remove("live"));
    live = document.createElement("div");
    live.className = "seg live";
    live.dataset.start = start;
    const ts = document.createElement("bdi");
    ts.className = "ts";
    ts.textContent = `[${formatTs(start)}]`;
    const span = document.createElement("span");
    live.append(ts, span);
    els.transcriptBody.appendChild(live);
  }
  live.querySelector("span").textContent = text.trim();
  els.transcriptBody.scrollTop = els.transcriptBody.scrollHeight;
}

/* ===== Analysis via WebLLM ===== */
// Kicked off in parallel with transcription so the model download/compile
// overlaps the transcription instead of running after it.
function preloadLLM() {
  if (!hasWebGPU || state.enginePromise) return;
  state.enginePromise = (async () => {
    const webllm = await import("https://esm.run/@mlc-ai/web-llm");
    return webllm.CreateMLCEngine(LLM_MODEL, {
      initProgressCallback: (report) => {
        const percent = typeof report.progress === "number" ? Math.round(report.progress * 100) : null;
        if (state.stage === "llm") {
          if (percent != null) setProgressBar(percent);
          setDetail(report.text || "");
        } else if (percent != null && percent < 100) {
          // Transcription is on screen — note the background download quietly.
          setDetail(`מודל הניתוח יורד ברקע: ${percent}%`);
        }
      },
    });
  })();
  state.enginePromise.catch(() => { state.enginePromise = null; });
  return state.enginePromise;
}

async function analyze(segments) {
  const engine = await (state.enginePromise || preloadLLM());

  state.stage = "analyzing";
  setStage("מנתח ומסכם את השיחה…");
  setDetail("");
  setProgressBar(0);

  let transcript = segments.map((s) => `[${formatTs(s.start)}] ${s.text}`).join("\n");
  let truncated = false;
  if (transcript.length > MAX_ANALYSIS_CHARS) {
    transcript = transcript.slice(0, MAX_ANALYSIS_CHARS);
    truncated = true;
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `תמליל השיחה (עם חותמות זמן):\n\n${transcript}` },
  ];

  // Stream the generation so the progress percentage moves in real time.
  let raw = "";
  try {
    const stream = await engine.chat.completions.create({ messages, temperature: 0.2, stream: true });
    for await (const chunk of stream) {
      raw += chunk.choices?.[0]?.delta?.content || "";
      setProgressBar(Math.min(95, Math.round(raw.length / 12)));
    }
  } catch {
    const resp = await engine.chat.completions.create({
      messages, temperature: 0.2, response_format: { type: "json_object" },
    });
    raw = resp.choices[0].message.content;
  }

  let parsed = parseAnalysisJson(raw);
  if (!parsed) {
    // One structured retry before giving up on JSON.
    try {
      const resp = await engine.chat.completions.create({
        messages, temperature: 0.2, response_format: { type: "json_object" },
      });
      parsed = parseAnalysisJson(resp.choices[0].message.content);
      if (parsed) raw = resp.choices[0].message.content;
    } catch { /* keep raw */ }
  }
  setProgressBar(100);
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

/* ===== Init ===== */
tryRestoreSession();
