// Whisper transcription inside a Web Worker (transformers.js).
// Runs on WebGPU when available (several times faster), falls back to WASM.
// The audio never leaves the browser — models are fetched once from the
// HuggingFace CDN and cached.
const CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6";

let transcriber = null;
let loadedModel = null;
let loadedDevice = null;

self.onmessage = async (event) => {
  const { type, audio, model, duration } = event.data;
  if (type !== "transcribe") return;

  try {
    const tf = await import(CDN);

    // Aggregate download progress across all model files into one percentage.
    const files = {};
    const progress_callback = (p) => {
      if (p.status === "progress" && p.total) {
        files[p.file] = { loaded: p.loaded, total: p.total };
        let loaded = 0, total = 0;
        for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
        self.postMessage({ type: "download", percent: Math.min(100, Math.round((loaded / total) * 100)) });
      }
    };

    let hasWebGPU = false;
    try {
      hasWebGPU = !!(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter()));
    } catch { hasWebGPU = false; }

    if (!transcriber || loadedModel !== model) {
      transcriber = null;
      if (hasWebGPU) {
        try {
          transcriber = await tf.pipeline("automatic-speech-recognition", model, {
            device: "webgpu",
            dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
            progress_callback,
          });
          loadedDevice = "webgpu";
        } catch {
          transcriber = null; // fall through to WASM
        }
      }
      if (!transcriber) {
        transcriber = await tf.pipeline("automatic-speech-recognition", model, {
          device: "wasm",
          dtype: "q8",
          progress_callback,
        });
        loadedDevice = "wasm";
      }
      loadedModel = model;
    }

    self.postMessage({ type: "stage", stage: "transcribing", device: loadedDevice });

    // Stream live text + percentage while whisper works through the audio.
    let streamer;
    let chunkOffset = 0;
    let liveText = "";
    try {
      const time_precision =
        transcriber.processor.feature_extractor.config.chunk_length /
        transcriber.model.config.max_source_positions;
      streamer = new tf.WhisperTextStreamer(transcriber.tokenizer, {
        time_precision,
        on_chunk_start: (x) => {
          chunkOffset = x;
          liveText = "";
          if (duration) {
            self.postMessage({ type: "progress", percent: Math.min(99, Math.round((x / duration) * 100)) });
          }
        },
        callback_function: (text) => {
          liveText += text;
          self.postMessage({ type: "partial", start: chunkOffset, text: liveText });
        },
      });
    } catch {
      streamer = undefined; // older lib layout — transcribe without live streaming
    }

    const output = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      force_full_sequences: false,
      streamer,
    });

    const segments = (output.chunks || [])
      .map((chunk) => ({
        start: chunk.timestamp?.[0] ?? 0,
        end: chunk.timestamp?.[1] ?? chunk.timestamp?.[0] ?? 0,
        text: (chunk.text || "").trim(),
      }))
      .filter((seg) => seg.text);

    if (!segments.length && (output.text || "").trim()) {
      segments.push({ start: 0, end: duration || 0, text: output.text.trim() });
    }

    self.postMessage({ type: "result", segments });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message || err) });
  }
};
