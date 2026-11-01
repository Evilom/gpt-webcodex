"""MCP 2026-07-28 (stateless) requests, as sent by OpenAI tunnel-client 0.0.16.

The tunnel probes with ``server/discover`` in the modern era and only falls back
to the legacy ``initialize`` handshake when the probe fails. Before this was
supported, every probe returned HTTP 400 and filled tunnel.log with errors.
"""

import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from coding_tools_mcp import server
from coding_tools_mcp.protocol import (
    HEADER_MISMATCH,
    META_SERVER_INFO,
    UNSUPPORTED_PROTOCOL_VERSION,
    dispatch_rpc,
)

TOKEN = "modern-protocol-test-token"
MODERN = "2026-07-28"


def modern_meta(version=MODERN):
    # Exactly what tunnel-client 0.0.16 sends (captured through `tunnel-client dev proxy`).
    return {
        "io.modelcontextprotocol/clientCapabilities": {"roots": {"listChanged": True}},
        "io.modelcontextprotocol/clientInfo": {"name": "tunnel-client", "version": "0.0.16"},
        "io.modelcontextprotocol/protocolVersion": version,
    }


class ModernDispatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = server.Runtime(Path(self.temp.name))

    def tearDown(self):
        self.runtime.close()
        self.temp.cleanup()

    def test_modern_discover_returns_supported_versions_without_handshake(self):
        response = dispatch_rpc(self.runtime, {"jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": {"_meta": modern_meta()}})
        result = response["result"]
        self.assertEqual(result["supportedVersions"], [MODERN])
        self.assertEqual(result["resultType"], "complete")
        self.assertEqual(result["_meta"][META_SERVER_INFO]["name"], "coding-tools-mcp")
        self.assertEqual(result["cacheScope"], "private")
        self.assertFalse(self.runtime.initialized, "a stateless probe must not mark the shared runtime initialized")

    def test_legacy_discover_keeps_desktop_shape(self):
        # The desktop client sends server/discover without _meta and reads tools + serverInfo.
        response = dispatch_rpc(self.runtime, {"jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": {}})
        result = response["result"]
        self.assertIn("tools", result)
        self.assertIn("schemaHash", result["serverInfo"])
        self.assertNotIn("resultType", result)

    def test_modern_tools_list_and_call(self):
        listed = dispatch_rpc(self.runtime, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {"_meta": modern_meta()}})
        names = [tool["name"] for tool in listed["result"]["tools"]]
        self.assertIn("server_info", names)
        self.assertEqual(listed["result"]["resultType"], "complete")
        called = dispatch_rpc(self.runtime, {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "server_info", "arguments": {}, "_meta": modern_meta()},
        })
        self.assertIn("result", called, called)
        self.assertEqual(called["result"]["resultType"], "complete")

    def test_modern_meta_errors(self):
        unknown = dispatch_rpc(self.runtime, {"jsonrpc": "2.0", "id": 4, "method": "server/discover", "params": {"_meta": modern_meta("2099-01-01")}})
        self.assertEqual(unknown["error"]["code"], UNSUPPORTED_PROTOCOL_VERSION)
        meta = modern_meta()
        del meta["io.modelcontextprotocol/clientCapabilities"]
        missing = dispatch_rpc(self.runtime, {"jsonrpc": "2.0", "id": 5, "method": "server/discover", "params": {"_meta": meta}})
        self.assertEqual(missing["error"]["code"], -32602)
        handshake = dispatch_rpc(self.runtime, {"jsonrpc": "2.0", "id": 6, "method": "initialize", "params": {"_meta": modern_meta()}})
        self.assertIn("result", handshake, "initialize is always legacy, whatever its _meta says")

    def test_failed_modern_notification_is_silent(self):
        self.assertIsNone(dispatch_rpc(self.runtime, {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"_meta": modern_meta("2099-01-01")}}))


class ModernHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = server.Runtime(Path(self.temp.name), auth_token=TOKEN, transport="http")
        self.httpd = server.RuntimeHTTPServer(("127.0.0.1", 0), server.MCPHandler, self.runtime, None)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.runtime.close()
        self.temp.cleanup()

    def post(self, body, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=10)
        merged = {"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}", "Accept": "application/json, text/event-stream"}
        merged.update(headers or {})
        connection.request("POST", "/mcp", json.dumps(body), merged)
        response = connection.getresponse()
        raw = response.read()
        session = response.getheader("Mcp-Session-Id")
        connection.close()
        return response.status, (json.loads(raw) if raw else None), session

    def test_tunnel_discover_probe_succeeds(self):
        status, payload, session = self.post(
            {"jsonrpc": "2.0", "id": "openai-mcp-discover", "method": "server/discover", "params": {"_meta": modern_meta()}},
            {"MCP-Protocol-Version": MODERN, "Mcp-Method": "server/discover"},
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["result"]["supportedVersions"], [MODERN])
        self.assertIsNone(session, "stateless requests must not be given an HTTP session")

    def test_modern_tools_call_requires_matching_mirror_headers(self):
        body = {"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                "params": {"name": "server_info", "arguments": {}, "_meta": modern_meta()}}
        status, payload, _ = self.post(body, {"MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call", "Mcp-Name": "server_info"})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["result"]["resultType"], "complete")
        status, payload, _ = self.post(body, {"MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call", "Mcp-Name": "exec_command"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], HEADER_MISMATCH)
        status, payload, _ = self.post(body, {"MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["data"]["header"], "Mcp-Name")

    def test_unsupported_meta_version_reports_body_fault(self):
        status, payload, _ = self.post(
            {"jsonrpc": "2.0", "id": 8, "method": "server/discover", "params": {"_meta": modern_meta("2099-01-01")}},
            {"MCP-Protocol-Version": MODERN, "Mcp-Method": "server/discover"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], UNSUPPORTED_PROTOCOL_VERSION)

    def test_modern_version_header_over_legacy_body_is_rejected(self):
        status, payload, _ = self.post(
            {"jsonrpc": "2.0", "id": 9, "method": "server/discover", "params": {}},
            {"MCP-Protocol-Version": MODERN},
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], HEADER_MISMATCH)

    def test_legacy_handshake_still_works(self):
        status, payload, session = self.post(
            {"jsonrpc": "2.0", "id": 10, "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}}},
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["result"]["protocolVersion"], "2025-11-25")
        self.assertTrue(session)
        status, payload, _ = self.post(
            {"jsonrpc": "2.0", "id": 11, "method": "tools/list", "params": {}},
            {"MCP-Protocol-Version": "2025-11-25", "Mcp-Session-Id": session},
        )
        self.assertEqual(status, 200, payload)
        self.assertNotIn("resultType", payload["result"])
        status, payload, _ = self.post({"jsonrpc": "2.0", "id": 12, "method": "tools/list", "params": {}}, {"MCP-Protocol-Version": "2099-01-01"})
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
