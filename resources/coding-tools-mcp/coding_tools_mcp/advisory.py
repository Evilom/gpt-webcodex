"""Forward bounded advisory calls to the desktop secret owner, never to a model directly."""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from .errors import ToolFailure


def consult(args, token, *, image_jobs=False):
    url = os.environ.get("CODING_TOOLS_MCP_ADVISORY_URL", "")
    if not url or not token:
        if args.get("action", "status") == "status":
            if image_jobs:
                return {"configured": False, "enabled": False, "message": "桌面异步生图入口尚未连接；继续主任务。"}
            return {"configured": False, "enabled": False, "selected": [], "advisory_only": True,
                    "message": "桌面辅助接口尚未连接；继续主任务，不要求用户手工发起咨询。"}
        raise ToolFailure("ADVISORY_UNAVAILABLE", "桌面辅助接口尚未连接。", category="runtime")
    target = urllib.parse.urlparse(url)
    if target.scheme != "http" or target.hostname != "127.0.0.1" or target.path != "/advisory" or target.username or target.password or target.query or target.fragment:
        raise ToolFailure("ADVISORY_UNAVAILABLE", "辅助接口必须是桌面启动时提供的本地回环地址。", category="runtime")
    if image_jobs:
        url = urllib.parse.urlunparse(target._replace(path="/image-jobs"))
    body = json.dumps(args, ensure_ascii=False).encode("utf-8")
    if len(body) > 65536:
        raise ToolFailure("ADVISORY_INPUT_TOO_LARGE", "辅助材料过大；请选择必要片段，不能自动截断。", category="validation")
    request = urllib.request.Request(url, data=body, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *unused):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=12) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise ToolFailure("ADVISORY_RESPONSE_TOO_LARGE", "辅助结果过大；保留原任务 ID，不重新提交。", category="runtime")
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read(65536))
        return {"ok": False, "error": {"code": "ADVISORY_REQUEST_FAILED", "message": payload.get("error", "辅助调用失败")}, "job": payload.get("job"),
                "advisory_only": True, "recovery": "查询原 request_id/job_id；不要自动重发或切换模型。"}
    except (OSError, ValueError) as error:
        raise ToolFailure("ADVISORY_CONNECTION_FAILED", "辅助连接未确认；查询原 request_id，不要重发。", category="runtime",
                          details={"request_id": args.get("request_id"), "job_id": args.get("job_id")}) from error
