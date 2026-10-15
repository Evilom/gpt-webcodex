"""Bounded local transport evidence. Never records tool arguments or response bodies."""
from __future__ import annotations

import hashlib
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()
MAX_TRACE_BYTES = 5 * 1024 * 1024
_FIELDS = frozenset({
    "transport_id", "rpc_id", "session_hash", "runtime_instance_id", "origin", "method", "tool",
    "operation_id", "execution_id", "status", "duration_ms", "response_bytes", "error_type",
    "result_available", "delivery_stage", "upstream_request_id",
})


def trace_id(value: Any) -> str | int | None:
    if value is None or isinstance(value, int) and not isinstance(value, bool):
        return value
    text = str(value)
    if len(text) <= 160 and all(char.isalnum() or char in "_-.:" for char in text):
        return text
    return "sha256:" + hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:24]


class RpcTraceStore:
    def __init__(self, workspace: Path) -> None:
        self.path = workspace / ".coding-tools" / "rpc-trace.jsonl"

    def record(self, event: str, **fields: Any) -> None:
        record = {"time": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "event": event}
        record.update({key: trace_id(value) if isinstance(value, str) else value for key, value in fields.items() if key in _FIELDS and (value is None or isinstance(value, (str, int, float, bool)))})
        try:
            with _LOCK:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                if self.path.exists() and self.path.stat().st_size >= MAX_TRACE_BYTES:
                    self.path.replace(self.path.with_suffix(".jsonl.1"))
                with self.path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        except OSError:
            pass  # Diagnostic storage must never change the outcome of a request.
