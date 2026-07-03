import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field

log = logging.getLogger("call_analyzer.jobs")


def sse(event: str, data: dict, event_id: int | None = None) -> str:
    prefix = f"id: {event_id}\n" if event_id is not None else ""
    return f"{prefix}event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@dataclass
class Job:
    """Events are kept in an in-memory history so a client that reconnects
    (mobile browser backgrounded, page reloaded) can replay from where it
    stopped via the SSE Last-Event-ID header or an ?after= query param.
    Nothing is written to disk; the reaper purges the job after the TTL."""

    id: str
    created_at: float
    history: list = field(default_factory=list)
    updated: "asyncio.Event" = field(default_factory=asyncio.Event)
    done: bool = False

    def emit(self, event: str, data: dict) -> None:
        self.history.append((event, data))
        if event in ("done", "error"):
            self.done = True
        self.updated.set()


class JobRegistry:
    """In-memory only. Entries are dropped by the reaper after the TTL —
    nothing about a call outlives the session window."""

    def __init__(self, ttl_seconds: int) -> None:
        self._jobs: dict[str, Job] = {}
        self._ttl = ttl_seconds

    def create(self) -> Job:
        job = Job(id=uuid.uuid4().hex, created_at=time.monotonic())
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
                job = self._jobs.pop(job_id, None)
                if job:
                    job.updated.set()  # wake any lingering stream so it can exit
                log.info("reaper purged job %s", job_id)
