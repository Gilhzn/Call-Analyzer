"""Split any audio file into standalone mono/16kHz PCM16 WAV chunks, so files
over the cloud provider's 25MB upload cap can be transcribed part by part.
Decoding uses PyAV (bundled with faster-whisper) — no system ffmpeg needed.
Chunks are written to a caller-owned temp dir and deleted with it."""
import logging
import os
import wave

log = logging.getLogger("call_analyzer.audio_split")

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2


def split_to_wav_chunks(path: str, dst_dir: str, chunk_seconds: int = 600) -> list[tuple[str, float]]:
    """Returns [(chunk_path, offset_seconds), ...] in playback order."""
    import av

    max_bytes = chunk_seconds * SAMPLE_RATE * BYTES_PER_SAMPLE
    chunks: list[tuple[str, float]] = []
    writer: wave.Wave_write | None = None
    written = 0
    total_samples = 0

    def open_chunk() -> wave.Wave_write:
        nonlocal writer, written
        chunk_path = os.path.join(dst_dir, f"chunk_{len(chunks) + 1:03d}.wav")
        chunks.append((chunk_path, total_samples / SAMPLE_RATE))
        writer = wave.open(chunk_path, "wb")
        writer.setnchannels(1)
        writer.setsampwidth(BYTES_PER_SAMPLE)
        writer.setframerate(SAMPLE_RATE)
        written = 0
        return writer

    def write(data: bytes) -> None:
        nonlocal writer, written, total_samples
        while data:
            if writer is None or written >= max_bytes:
                if writer is not None:
                    writer.close()
                open_chunk()
            room = max_bytes - written
            piece = data[:room]
            writer.writeframes(piece)
            written += len(piece)
            total_samples += len(piece) // BYTES_PER_SAMPLE
            data = data[room:]

    with av.open(path) as container:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        stream = container.streams.audio[0]
        for frame in container.decode(stream):
            for resampled in resampler.resample(frame):
                write(bytes(resampled.planes[0])[: resampled.samples * BYTES_PER_SAMPLE])
        for resampled in resampler.resample(None):  # flush
            write(bytes(resampled.planes[0])[: resampled.samples * BYTES_PER_SAMPLE])

    if writer is not None:
        writer.close()
    log.info("split audio into %d chunks (%.1fs total)", len(chunks), total_samples / SAMPLE_RATE)
    return chunks
