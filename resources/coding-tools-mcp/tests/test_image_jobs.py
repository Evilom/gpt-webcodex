import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from io import BytesIO

from coding_tools_mcp.advisory import consult
from coding_tools_mcp.server import Runtime


class Response(BytesIO):
    def __enter__(self): return self
    def __exit__(self, *unused): self.close()


class ImageJobsTests(unittest.TestCase):
    def test_smart_tool_and_disabled_status_do_not_change_the_main_task(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"CODING_TOOLS_MCP_TOOL_MODE": "smart", "CODING_TOOLS_MCP_ADVISORY_URL": ""}):
            runtime = Runtime(Path(directory), permission_mode="dangerous")
            try:
                self.assertIn("image_jobs", runtime.exposed_tool_names())
                self.assertIn("Do not loop or wait", runtime.initialize()["instructions"])
                runtime.task_state.ensure_started("继续主任务")
                before = runtime.task_state.get()
                result = runtime.call_tool("image_jobs", {"action": "status"})
                self.assertFalse(result["structuredContent"]["enabled"])
                runtime._record_task_tool_result("image_jobs", {"action": "result"}, {"status": "failed"})
                self.assertEqual(runtime.task_state.get(), before)
            finally:
                runtime.close()

    def test_image_route_uses_only_the_same_validated_loopback_bridge(self):
        with patch.dict(os.environ, {"CODING_TOOLS_MCP_ADVISORY_URL": "http://127.0.0.1:18769/advisory"}), patch("urllib.request.build_opener") as factory:
            factory.return_value.open.return_value = Response(b'{"id":"image_job_001","status":"queued"}')
            brief = {"action": "submit", "request_id": "image_job_001", "prompt": "清楚的参考图"}
            self.assertEqual(consult(brief, "fixture-token", image_jobs=True)["status"], "queued")
            request = factory.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "http://127.0.0.1:18769/image-jobs")
            self.assertEqual(json.loads(request.data), brief)
            self.assertEqual(factory.call_args.args[0].proxies, {})

    def test_preview_is_explicit_image_content_and_never_duplicates_base64_in_text_or_metadata(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
            runtime = Runtime(Path(directory), permission_mode="dangerous")
            try:
                image = {"id": "image_job_001", "review_status": "pending", "mime_type": "image/jpeg", "_mcp_image_data": "fixture-preview-bytes"}
                with patch("coding_tools_mcp.advisory.consult", return_value=image):
                    result = runtime.call_tool("image_jobs", {"action": "preview", "job_id": "image_job_001"})
                self.assertEqual(result["content"][0]["type"], "image")
                self.assertNotIn("_mcp_image_data", result["structuredContent"])
                self.assertIn("尚未完成内容审核", result["content"][1]["text"])
                self.assertNotIn("fixture-preview-bytes", result["content"][1]["text"])
                self.assertTrue(runtime._call_is_read_only("image_jobs", {"action": "preview"}))
                self.assertFalse(runtime._call_is_read_only("image_jobs", {"action": "submit"}))
            finally:
                runtime.close()
