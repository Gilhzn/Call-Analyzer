from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Whisper
    whisper_model: str = "small"
    whisper_device: str = "auto"
    whisper_compute_type: str = "int8"
    whisper_preload: bool = False
    # 1 = greedy decoding (fastest, near-identical quality); 5 = beam search
    whisper_beam_size: int = 1
    # 0 = use all available CPU cores
    whisper_cpu_threads: int = 0

    # Groq free-tier cloud boost (optional): when a key is set, transcription
    # and analysis run on Groq's GPU servers instead of locally.
    groq_api_key: str = ""
    groq_base_url: str = "https://api.groq.com/openai/v1"
    groq_asr_model: str = "whisper-large-v3-turbo"
    groq_llm_model: str = "openai/gpt-oss-120b"
    # ~5.5k tokens — inside the free tier's 8K tokens/minute window
    groq_max_analysis_chars: int = 14000

    # Ollama
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "gemma3:4b"
    ollama_timeout_seconds: float = 300.0
    ollama_num_ctx: int = 8192

    # Server
    max_upload_mb: int = 200
    max_concurrent_jobs: int = 1
    job_ttl_seconds: int = 600

    # Analysis chunking
    analysis_chunk_chars: int = 6000
    analysis_max_chunks: int = 10

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


@lru_cache
def get_settings() -> Settings:
    return Settings()
