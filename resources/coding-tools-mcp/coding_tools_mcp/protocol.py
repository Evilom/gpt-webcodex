from __future__ import annotations

from typing import Any

from .errors import JsonRpcError


PROTOCOL_VERSION = "2025-11-25"
# Legacy versions are negotiated once by ``initialize``.
SUPPORTED_PROTOCOL_VERSIONS = (PROTOCOL_VERSION, "2025-06-18")
# Modern (stateless) versions travel in ``params._meta`` of every request.
# tunnel-client probes with ``server/discover`` in this era and only falls back
# to the legacy handshake when the probe fails.
MODERN_PROTOCOL_VERSIONS = ("2026-07-28",)
KNOWN_PROTOCOL_VERSIONS = (*MODERN_PROTOCOL_VERSIONS, *SUPPORTED_PROTOCOL_VERSIONS)
LEGACY_ERA = "legacy"
MODERN_ERA = "modern"

META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion"
META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"
META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo"
META_SERVER_INFO = "io.modelcontextprotocol/serverInfo"

HEADER_MISMATCH = -32020
UNSUPPORTED_PROTOCOL_VERSION = -32022

MODERN_METHODS = frozenset({"server/discover", "notifications/cancelled", "ping", "tools/list", "tools/call"})
MODERN_CACHEABLE_METHODS = frozenset({"server/discover", "tools/list"})
# Modern clients read the HTTP status as well as the JSON-RPC error.
MODERN_ERROR_STATUSES = {-32601: 404, -32602: 400, HEADER_MISMATCH: 400, UNSUPPORTED_PROTOCOL_VERSION: 400}
# The request subject a modern request mirrors in the Mcp-Name header.
MIRRORED_NAME_METHODS = {"tools/call": "name"}


def jsonrpc_error(
    request_id: str | int | None, code: int, message: str, data: Any = None
) -> dict[str, Any]:
    """Build a JSON-RPC error response envelope."""
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


def invalid_request_response() -> dict[str, Any]:
    return jsonrpc_error(None, -32600, "Invalid Request")


def response_id(request: dict[str, Any]) -> str | int | None:
    """Return a response-safe JSON-RPC id, using null for invalid or absent ids."""

    value = request.get("id")
    if isinstance(value, str) or (isinstance(value, int) and not isinstance(value, bool)):
        return value
    return None


def validate_rpc_envelope(request: dict[str, Any]) -> None:
    if request.get("jsonrpc") != "2.0":
        raise JsonRpcError(-32600, "Invalid Request: jsonrpc must be 2.0", {"reason": "jsonrpc_version"})
    method = request.get("method")
    if not isinstance(method, str) or not method:
        raise JsonRpcError(-32600, "Invalid Request: method must be a string", {"reason": "method"})
    if "id" in request and not (
        request["id"] is None
        or isinstance(request["id"], str)
        or (isinstance(request["id"], int) and not isinstance(request["id"], bool))
    ):
        raise JsonRpcError(-32600, "Invalid Request: id must be string, integer, or null", {"reason": "id"})


def rpc_params(request: dict[str, Any]) -> dict[str, Any]:
    params = request.get("params", {})
    if params is None:
        return {}
    if not isinstance(params, dict):
        raise JsonRpcError(-32602, "MCP method params must be an object")
    return params


def validate_initialize_params(params: dict[str, Any]) -> str:
    requested = params.get("protocolVersion")
    if requested is None:
        return PROTOCOL_VERSION
    if not protocol_version_is_supported(requested):
        raise JsonRpcError(
            -32602,
            "Unsupported MCP protocol version",
            {"supported": list(SUPPORTED_PROTOCOL_VERSIONS), "received": requested},
        )
    return str(requested)


def validate_initialize_request(request: dict[str, Any]) -> None:
    if "id" not in request or request.get("id") is None:
        raise JsonRpcError(-32600, "initialize must be a JSON-RPC request with a non-null id")


def protocol_version_is_supported(version: Any) -> bool:
    return isinstance(version, str) and version in SUPPORTED_PROTOCOL_VERSIONS


def protocol_version_is_known(version: Any) -> bool:
    return isinstance(version, str) and version in KNOWN_PROTOCOL_VERSIONS


def request_era(method: str, params: dict[str, Any]) -> str:
    """A request is modern only when its ``_meta`` states the protocol version.

    ``initialize`` is always legacy, and legacy requests may carry unrelated
    ``_meta`` entries such as ``progressToken``, so the key itself must be present.
    """

    if method == "initialize":
        return LEGACY_ERA
    meta = params.get("_meta")
    if isinstance(meta, dict) and META_PROTOCOL_VERSION in meta:
        return MODERN_ERA
    return LEGACY_ERA


def validate_modern_meta(params: dict[str, Any]) -> str:
    """Validate the ``_meta`` fields a modern request owes and return its version."""

    meta = params["_meta"]
    version = meta[META_PROTOCOL_VERSION]
    if not isinstance(version, str):
        raise JsonRpcError(-32602, f"{META_PROTOCOL_VERSION} must be a string", {"reason": "protocol_version"})
    if version not in MODERN_PROTOCOL_VERSIONS:
        raise JsonRpcError(
            UNSUPPORTED_PROTOCOL_VERSION,
            f"Unsupported MCP protocol version in _meta: {version}",
            {"supported": list(MODERN_PROTOCOL_VERSIONS), "received": version},
        )
    if not isinstance(meta.get(META_CLIENT_CAPABILITIES), dict):
        raise JsonRpcError(
            -32602,
            f"{META_CLIENT_CAPABILITIES} is required and must be an object",
            {"reason": "client_capabilities"},
        )
    if META_CLIENT_INFO in meta and not isinstance(meta[META_CLIENT_INFO], dict):
        raise JsonRpcError(-32602, f"{META_CLIENT_INFO} must be an object when present", {"reason": "client_info"})
    return version


def validate_mirror_headers(
    era: str,
    method: str,
    params: dict[str, Any],
    *,
    version_header: str | None,
    method_header: str | None,
    name_header: str | None,
) -> None:
    """Check that a modern request's routing headers repeat its body.

    Legacy requests carry no mirror headers, except that a modern version
    header over a legacy body is a mismatch.
    """

    if era != MODERN_ERA:
        if version_header in MODERN_PROTOCOL_VERSIONS:
            raise _mirror_error(
                "MCP-Protocol-Version",
                f"MCP-Protocol-Version {version_header} needs params._meta.{META_PROTOCOL_VERSION} with the same version",
                "body_is_not_modern",
            )
        return
    meta = params.get("_meta")
    meta_version = meta.get(META_PROTOCOL_VERSION) if isinstance(meta, dict) else None
    if version_header is None:
        raise _mirror_error("MCP-Protocol-Version", "MCP-Protocol-Version is required for modern requests", "missing")
    if version_header != meta_version:
        raise _mirror_error("MCP-Protocol-Version", "MCP-Protocol-Version does not match params._meta", "mismatch")
    if method_header is None:
        raise _mirror_error("Mcp-Method", "Mcp-Method is required and must repeat the request method", "missing")
    if method_header != method:
        raise _mirror_error("Mcp-Method", "Mcp-Method does not match the request method", "mismatch")
    subject = MIRRORED_NAME_METHODS.get(method)
    if subject is None:
        return
    if name_header is None:
        raise _mirror_error("Mcp-Name", f"Mcp-Name is required for {method}", "missing")
    if name_header != params.get(subject):
        raise _mirror_error("Mcp-Name", f"Mcp-Name does not match params.{subject}", "mismatch")


def _mirror_error(header: str, message: str, reason: str) -> JsonRpcError:
    return JsonRpcError(HEADER_MISMATCH, message, {"header": header, "reason": reason})


def modern_rpc_status(response: dict[str, Any] | None) -> int:
    error = response.get("error") if isinstance(response, dict) else None
    if not isinstance(error, dict):
        return 200
    return MODERN_ERROR_STATUSES.get(error.get("code"), 200)


def _shape_modern_result(runtime: Any, method: str, result: dict[str, Any]) -> dict[str, Any]:
    """Add the fields a modern client expects without touching the runtime's dict."""

    shaped = dict(result)
    shaped["resultType"] = "complete"
    carried = shaped.get("_meta")
    meta = dict(carried) if isinstance(carried, dict) else {}
    meta[META_SERVER_INFO] = runtime.server_identity()
    shaped["_meta"] = meta
    if method in MODERN_CACHEABLE_METHODS:
        # The catalog depends on workspace and permission mode: never share or reuse it.
        shaped["ttlMs"] = 0
        shaped["cacheScope"] = "private"
    return shaped


def _dispatch_modern(runtime: Any, request: dict[str, Any], method: str, params: dict[str, Any]) -> dict[str, Any] | None:
    """Serve a stateless request: no handshake, no session state touched."""

    validate_modern_meta(params)
    if method not in MODERN_METHODS:
        raise JsonRpcError(-32601, f"Unknown method: {method}")
    if method == "notifications/cancelled":
        cancelled_request_id = params.get("requestId")
        if isinstance(cancelled_request_id, (str, int)) and not isinstance(cancelled_request_id, bool):
            runtime.cancel_request(cancelled_request_id)
        return None
    if method == "ping":
        return {}
    if method == "server/discover":
        return runtime.discover_payload()
    if method == "tools/list":
        return runtime.list_tools()
    return _call_tool(runtime, params, request.get("id"))


def _call_tool(runtime: Any, params: dict[str, Any], request_id: Any) -> dict[str, Any]:
    if not isinstance(params.get("name"), str):
        raise JsonRpcError(-32602, "tools/call requires a tool name")
    arguments = params.get("arguments") or {}
    if not isinstance(arguments, dict):
        raise JsonRpcError(-32602, "tools/call arguments must be an object")
    return runtime.call_tool(params["name"], arguments, request_id=request_id)


def dispatch_rpc(runtime: Any, request: dict[str, Any]) -> dict[str, Any] | None:
    """Dispatch one MCP JSON-RPC request against a runtime, shared by all transports.

    Handshake state lives on ``runtime.initialized``; transports add only their
    transport-specific framing (session headers, stream handling) around this.
    Returns None for notifications and requests without an id.
    """

    request_id = request.get("id")
    try:
        validate_rpc_envelope(request)
        method = request["method"]
        params = rpc_params(request)
        if request_era(method, params) == MODERN_ERA:
            try:
                result = _dispatch_modern(runtime, request, method, params)
            except JsonRpcError:
                if "id" not in request:
                    return None  # JSON-RPC: a failed notification is answered with nothing.
                raise
            if result is None or request_id is None:
                return None
            return {"jsonrpc": "2.0", "id": request_id, "result": _shape_modern_result(runtime, method, result)}
        if not runtime.initialized and method not in {"initialize", "ping", "server/discover"}:
            raise JsonRpcError(-32002, "Server not initialized")
        if method == "initialize":
            validate_initialize_request(request)
            runtime.protocol_version = validate_initialize_params(params)
            client_info = params.get("clientInfo")
            result = runtime.initialize(client_info if isinstance(client_info, dict) else None)
            runtime.initialized = True
        elif method == "notifications/initialized":
            return None
        elif method == "notifications/cancelled":
            cancelled_request_id = params.get("requestId")
            if isinstance(cancelled_request_id, (str, int)) and not isinstance(cancelled_request_id, bool):
                runtime.cancel_request(cancelled_request_id)
            return None
        elif method == "ping":
            result = {}
        elif method == "server/discover":
            server_info = runtime.server_info_payload()
            result = {
                "protocolVersion": runtime.protocol_version,
                "serverInfo": {
                    "name": "coding-tools-mcp",
                    "title": "Coding Tools MCP",
                    "version": server_info.get("version", ""),
                    "schemaVersion": server_info.get("schema_version", 0),
                    "schemaHash": server_info.get("schema_hash", ""),
                    "toolCount": server_info.get("tool_count", 0),
                    "runtimeInstanceId": server_info.get("runtime_instance_id", ""),
                    "processId": server_info.get("process_id", 0),
                    "launchId": server_info.get("launch_id", ""),
                    "sourceFingerprint": server_info.get("source_fingerprint", ""),
                    "workspace": str(runtime.workspace.root),
                },
                "capabilities": {"tools": {"listChanged": True}},
                "tools": runtime.list_tools().get("tools", []),
                "feedbackCapabilities": runtime.feedback_capabilities_payload(),
            }
        elif method == "tools/list":
            result = runtime.list_tools()
        elif method == "tools/call":
            result = _call_tool(runtime, params, request_id)
        else:
            raise JsonRpcError(-32601, f"Unknown method: {method}")
        if request_id is None:
            return None
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    except JsonRpcError as exc:
        return jsonrpc_error(response_id(request), exc.code, exc.message, exc.data)
