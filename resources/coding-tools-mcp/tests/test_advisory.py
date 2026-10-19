import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from coding_tools_mcp.advisory import consult
from coding_tools_mcp.errors import ToolFailure
from coding_tools_mcp.server import Runtime


class AdvisoryTests(unittest.TestCase):
    def test_smart_discovery_and_instructions_enable_ai_initiated_consultation(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"CODING_TOOLS_MCP_TOOL_MODE": "smart", "CODING_TOOLS_MCP_ADVISORY_URL": ""}):
            runtime = Runtime(Path(directory), permission_mode="dangerous")
            try:
                names = [tool["name"] for tool in runtime.list_tools()["tools"]]
                self.assertIn("consult_advisors", names)
                self.assertEqual(len(names), 12)
                self.assertIn("proactively consider consult_advisors", runtime.initialize()["instructions"])
                payload = runtime.call_tool("consult_advisors", {"action": "status"})["structuredContent"]
                self.assertFalse(payload["enabled"])
            finally:
                runtime.close()

    def test_remote_bridge_url_cannot_receive_mcp_credentials(self):
        with patch.dict(os.environ, {"CODING_TOOLS_MCP_ADVISORY_URL": "https://remote.example/advisory"}):
            with self.assertRaises(ToolFailure):
                consult({"action": "submit"}, "test-token")

    def test_no_bridge_reports_disabled_and_never_instructs_manual_submission(self):
        with patch.dict(os.environ, {"CODING_TOOLS_MCP_ADVISORY_URL": ""}):
            self.assertFalse(consult({"action": "status"}, "test-token")["enabled"])
            with self.assertRaises(ToolFailure):
                consult({"action": "submit"}, "test-token")

    def test_proxy_is_disabled_and_submit_brief_is_forwarded_exactly_once(self):
        from io import BytesIO
        class Response(BytesIO):
            def __enter__(self): return self
            def __exit__(self, *args): self.close()
        brief = {"action": "submit", "request_id": "fixture_job_123", "question": "复核设计", "context": [{"id": "proposal", "text": "保留健康进程"}]}
        with patch.dict(os.environ, {"CODING_TOOLS_MCP_ADVISORY_URL": "http://127.0.0.1:18769/advisory"}), patch("urllib.request.build_opener") as factory:
            factory.return_value.open.return_value = Response(b'{"id":"fixture_job_123","status":"preparing"}')
            result = consult(brief, "test-token")
            self.assertEqual(result["status"], "preparing")
            request = factory.return_value.open.call_args.args[0]
            self.assertEqual(json.loads(request.data), brief)
            self.assertEqual(request.headers["Authorization"], "Bearer test-token")
            self.assertEqual(factory.return_value.open.call_count, 1)
            self.assertEqual(factory.call_args.args[0].proxies, {})

    def test_failed_advice_does_not_fail_running_local_task(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
            runtime = Runtime(Path(directory), permission_mode="dangerous")
            try:
                runtime.task_state.ensure_started("本地开发任务")
                runtime._record_task_tool_result("consult_advisors", {"action": "result"}, {"status": "failed", "error": "timeout"})
                self.assertNotEqual(runtime.task_state.get()["status"], "failed")
            finally:
                runtime.close()

    def test_advice_body_is_visible_in_mcp_text_not_only_structured_content(self):
        from coding_tools_mcp.tool_results import make_tool_result
        result = make_tool_result("consult_advisors", {"id": "visible_job_123", "status": "completed", "responses": [{"model": "anthropic::claude-opus-5-5", "status": "answered", "answer": "保留健康 MCP 进程，记录已完成操作 ID。"}]}, is_error=False)
        self.assertIn("保留健康 MCP", result["content"][0]["text"])
        self.assertIn("未经主 AI 核验", result["content"][0]["text"])
