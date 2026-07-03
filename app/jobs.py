import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field

log = logging.getLogger("call_analyzer.jobs")


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@dataclass
class Job:
    id: str
    queue: "asyncio.Queue[tuple[str, dict]]"
    created_at: float
    consumed: bool = field(default=False)

    def emit(self, event: str, data: dict) -> None:
        self.queue.put_nowait((event, data))


class JobRegistry:
    """In-memory only. Entries are dropped as soon as their SSE stream closes,
    or by the reaper after the TTL — nothing about a call outlives the session."""

    def __init__(self, ttl_seconds: int) -> None:
        self._jobs: dict[str, Job] = {}
        self._ttl = ttl_seconds

    def create(self) -> Job:
        job = Job(id=uuid.uuid4().hex, queue=asyncio.Queue(), created_at=time.monotonic())
        self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def finish(self, job_id: str) -> None:
        self._jobs.pop(job_id, None)

    async def reaper(self) -> None:
        while True:
            await asyncio.sleep(60)
            cutoff = time.monotonic() - self._ttl
            expired = [job_id for job_id, job in self._jobs.items() if job.created_at < cutoff]
            for job_id in expired:
                self._jobs.pop(job_id, None)
                log.info("reaper purged job %s", job_id)
