from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from coding_tools_mcp import server as server_module
from coding_tools_mcp.server import Runtime


class ContextSearchBoundsTests(unittest.TestCase):
    def test_python_fallback_reads_only_binary_prefix(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            binary = root / "large.txt"
            with binary.open("wb") as output:
                output.write(b"\x00")
                output.truncate(64 * 1024 * 1024)
            runtime = Runtime(root)
            runtime.workspace.git_path = None
            original_open = Path.open
            bytes_read = 0

            def tracked_open(path, *args, **kwargs):
                nonlocal bytes_read
                stream = original_open(path, *args, **kwargs)
                if path.name != binary.name:
                    return stream
                wrapped = MagicMock(wraps=stream)
                wrapped.__enter__.return_value = wrapped
                wrapped.__exit__.side_effect = lambda *_args: stream.close()

                def read(*read_args):
                    nonlocal bytes_read
                    data = stream.read(*read_args)
                    bytes_read += len(data)
                    return data

                wrapped.read.side_effect = read
                return wrapped

            try:
                with patch.object(server_module, "cached_which", return_value=None), patch.object(Path, "open", tracked_open):
                    result = runtime.search_text({"query": "needle"})
                self.assertEqual(result["matches"], [])
                self.assertEqual(bytes_read, 4096)
            finally:
                runtime.close()

    def test_python_context_search_stops_at_match_limit_and_expired_budget(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(200):
                (root / f"file{index:03}.txt").write_text("needle\n", encoding="utf-8")
            runtime = Runtime(root)
            runtime.workspace.git_path = None
            opened = []
            original_open = Path.open

            def tracked_open(path, *args, **kwargs):
                if path.name.startswith("file"):
                    opened.append(path)
                return original_open(path, *args, **kwargs)

            try:
                with patch.object(server_module, "cached_which", return_value=None), patch.object(Path, "open", tracked_open):
                    runtime.request_context.context_search_deadline = time.monotonic() + 5
                    result = runtime.search_text({"query": "needle", "max_results": 2})
                    self.assertEqual(len(result["matches"]), 2)
                    self.assertTrue(result["truncated"])
                    self.assertLessEqual(len(opened), 2)
                    opened.clear()
                    runtime.request_context.context_search_deadline = time.monotonic() - 1
                    result = runtime.search_text({"query": "needle"})
                    self.assertEqual(result["matches"], [])
                    self.assertTrue(result["truncated"])
                    self.assertEqual(opened, [])
            finally:
                runtime.close()

    def test_rg_timeout_returns_partial_results_without_starting_python_scan(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "sample.txt").write_text("needle\n", encoding="utf-8")
            runtime = Runtime(root)
            event = {"type": "match", "data": {"path": {"text": "sample.txt"}, "line_number": 1, "lines": {"text": "needle\n"}}}
            code = f"import time; print({json.dumps(json.dumps(event))}, flush=True); time.sleep(3)"
            original_popen = subprocess.Popen

            def launch(_args, **kwargs):
                return original_popen([sys.executable, "-u", "-c", code], **kwargs)

            try:
                runtime.request_context.context_search_deadline = time.monotonic() + 1
                started = time.monotonic()
                with patch.object(server_module, "cached_which", return_value=sys.executable), patch.object(server_module.subprocess, "Popen", side_effect=launch), patch.object(server_module, "walk_files", side_effect=AssertionError("must not rescan after rg timeout")):
                    result = runtime.search_text({"query": "needle"})
                self.assertLess(time.monotonic() - started, 2.5)
                self.assertEqual(result["engine"], "rg")
                self.assertEqual(len(result["matches"]), 1)
                self.assertTrue(result["truncated"])
                self.assertFalse(result["total_matches_exact"])
            finally:
                runtime.close()

    def test_concurrent_preparations_share_four_search_workers(self) -> None:
        with TemporaryDirectory() as tmp:
            runtime = Runtime(Path(tmp))
            lock = threading.Lock()
            active = peak = 0

            def search(_args):
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(peak, active)
                time.sleep(0.03)
                with lock:
                    active -= 1
                return {"matches": [], "total_matches": 0}

            try:
                with patch.object(runtime, "search_text", side_effect=search):
                    with ThreadPoolExecutor(max_workers=6) as callers:
                        results = list(callers.map(lambda i: runtime.prepare_coding_context({"objective": f"probe {i}", "queries": [f"word {i}-{j}" for j in range(4)], "force_refresh": True}), range(6)))
                self.assertEqual(len(results), 6)
                self.assertGreater(peak, 1)
                self.assertLessEqual(peak, 4)
            finally:
                runtime.close()
