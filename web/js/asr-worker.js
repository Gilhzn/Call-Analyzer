// Whisper transcription inside a Web Worker (transformers.js, WASM/q8).
// The audio never leaves the browser — models are fetched once from the
// HuggingFace CDN and cached by the browser.
let transcriber = null;
let loadedModel = null;

self.onmessage = async (event) => {
  const { type, audio, model } = event.data;
  if (type !== "transcribe") return;

  try {
    const { pipeline } = await import(
      "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6"
    );

    if (!transcriber || loadedModel !== model) {
      transcriber = await pipeline("automatic-speech-recognition", model, {
        dtype: "q8",
        progress_callback: (p) => {
          if (p.status === "progress") {
            self.postMessage({
              type: "download",
              file: p.file,
              progress: Math.round(p.progress || 0),
            });
          }
        },
      });
      loadedModel = model;
    }

    self.postMessage({ type: "stage", stage: "transcribing" });
    const output = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    });

    const segments = (output.chunks || [])
      .map((chunk) => ({
        start: chunk.timestamp?.[0] ?? 0,
        end: chunk.timestamp?.[1] ?? chunk.timestamp?.[0] ?? 0,
        text: (chunk.text || "").trim(),
      }))
      .filter((seg) => seg.text);

    if (!segments.length && (output.text || "").trim()) {
      segments.push({ start: 0, end: 0, text: output.text.trim() });
    }

    self.postMessage({ type: "result", segments });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message || err) });
  }
};
