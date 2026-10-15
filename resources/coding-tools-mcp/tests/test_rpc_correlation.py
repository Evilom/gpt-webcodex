import http.client
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from coding_tools_mcp import server
from coding_tools_mcp.rpc_trace import RpcTraceStore


class RpcCorrelationTests(unittest.TestCase):
    def test_real_http_reply_and_background_poll_share_operation_not_rpc_id(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.dict("os.environ", {"CODING_TOOLS_MCP_TOOL_MODE": "smart"}):
                runtime = server.Runtime(root, permission_mode="dangerous")
            httpd = server.RuntimeHTTPServer(("127.0.0.1", 0), server.MCPHandler, runtime, None)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()

            def call(rpc_id, name, args):
                connection = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
                body = json.dumps({"jsonrpc": "2.0", "id": rpc_id, "method": "tools/call", "params": {"name": name, "arguments": args}})
                connection.request("POST", "/mcp", body, {"Content-Type": "application/json"})
                response = connection.getresponse()
                trace = response.getheader("X-Coding-Tools-Trace-Id")
                result = json.loads(response.read())
                connection.close()
                return trace, result

            entered, release = threading.Event(), threading.Event()
            original = runtime._tool_handlers["agent_workflow"]

            def workflow(args):
                entered.set()
                release.wait(3)
                return {"ok": True, "phase": "execute", "proof": "private-payload-not-in-logs"}

            runtime._tool_handlers["agent_workflow"] = workflow
            try:
                with patch.object(server, "LONG_TOOL_HANDOFF_SECONDS", 0.01):
                    first_trace, first = call("initial-101", "agent_workflow", {"phase": "execute", "objective": "private-objective"})
                self.assertTrue(entered.wait(1), first)
                operation_id = first["result"]["structuredContent"]["background_operation"]["operation_id"]
                release.set()
                runtime.background_operations[operation_id]["event"].wait(3)
                second_trace, second = call("poll-102", "task_control", {"action": "operation", "operation_id": operation_id})
                self.assertNotEqual(first_trace, second_trace)
                operation = second["result"]["structuredContent"]["background_operation"]
                self.assertEqual(operation["status"], "completed")
                self.assertIn("result", operation)
                deadline = time.monotonic() + 1
                while True:
                    records = [json.loads(line) for line in runtime.rpc_trace.path.read_text().splitlines()]
                    if any(item["event"] == "rpc.response_written" and item.get("transport_id") == second_trace for item in records) or time.monotonic() >= deadline:
                        break
                    time.sleep(0.01)
                finished = next(item for item in records if item["event"] == "operation.finished")
                self.assertEqual(finished["rpc_id"], "initial-101")
                self.assertEqual(finished["operation_id"], operation_id)
                for trace_id, rpc_id in [(first_trace, "initial-101"), (second_trace, "poll-102")]:
                    traced = [item for item in records if item.get("transport_id") == trace_id]
                    events = [item["event"] for item in traced]
                    self.assertIn("rpc.received", events)
                    self.assertIn("rpc.serialized", events)
                    self.assertIn("rpc.response_written", events)
                    self.assertTrue(all(item["rpc_id"] == rpc_id for item in traced))
                raw = runtime.rpc_trace.path.read_text()
                self.assertNotIn("private-objective", raw)
                self.assertNotIn("private-payload", raw)
            finally:
                release.set()
                runtime._tool_handlers["agent_workflow"] = original
                httpd.shutdown()
                httpd.server_close()
                runtime.close()

    def test_socket_write_failure_is_not_recorded_as_delivery(self):
        with tempfile.TemporaryDirectory() as temp:
            handler = object.__new__(server.MCPHandler)
            store = RpcTraceStore(Path(temp))
            handler._runtime = type("Runtime", (), {"rpc_trace": store})()
            handler.server = type("Server", (), {"control_runtime": handler._runtime})()
            handler._rpc_trace_context = {"transport_id": "test", "rpc_id": 7}
            handler.send_response = lambda *args: None
            handler.send_header = lambda *args: None
            handler.end_headers = lambda: None
            handler.send_cors_headers = lambda: None
            handler.wfile = type("BrokenSocket", (), {"write": lambda self, value: (_ for _ in ()).throw(BrokenPipeError())})()
            with self.assertRaises(BrokenPipeError):
                handler.send_json({"jsonrpc": "2.0", "id": 7, "result": {}})
            events = [json.loads(line)["event"] for line in store.path.read_text().splitlines()]
            self.assertIn("rpc.write_failed", events)
            self.assertNotIn("rpc.response_written", events)

    def test_trace_is_bounded_and_drops_bodies_headers_and_nested_values(self):
        with tempfile.TemporaryDirectory() as temp:
            store = RpcTraceStore(Path(temp))
            with patch("coding_tools_mcp.rpc_trace.MAX_TRACE_BYTES", 1):
                store.record("rpc.received", rpc_id=1, authorization="secret", body="private", tool={"secret": 1})
                store.record("rpc.response_written", rpc_id=2)
            self.assertTrue(store.path.with_suffix(".jsonl.1").exists())
            raw = store.path.read_text() + store.path.with_suffix(".jsonl.1").read_text()
            self.assertNotIn("secret", raw)
            self.assertNotIn("private", raw)
            self.assertNotIn('"tool"', raw)


if __name__ == "__main__":
    unittest.main()
