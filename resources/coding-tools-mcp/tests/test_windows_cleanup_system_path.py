import os
import unittest
from unittest.mock import Mock, patch

from coding_tools_mcp.processes import _windows_taskkill_tree


class WindowsCleanupSystemPathTests(unittest.TestCase):
    def test_cleanup_uses_system_utility_and_minimal_environment(self):
        process = Mock(pid=12345)
        process.poll.return_value = None
        with patch.dict(os.environ, {"SystemRoot": r"C:\Windows", "PATH": "untrusted-workspace", "SYNTHETIC_SECRET": "test"}, clear=True), patch("coding_tools_mcp.processes.subprocess.run") as run:
            _windows_taskkill_tree(process, force=True)
        self.assertEqual(run.call_args.args[0], [r"C:\Windows\System32\taskkill.exe", "/PID", "12345", "/T", "/F"])
        self.assertEqual(run.call_args.kwargs["cwd"], r"C:\Windows\System32")
        self.assertEqual(run.call_args.kwargs["env"], {"SystemRoot": r"C:\Windows", "WINDIR": r"C:\Windows"})

    def test_invalid_system_root_never_uses_path_lookup(self):
        process = Mock(pid=12345)
        process.poll.return_value = None
        with patch.dict(os.environ, {"SystemRoot": "relative"}, clear=True), patch("coding_tools_mcp.processes.subprocess.run") as run:
            _windows_taskkill_tree(process, force=True)
        run.assert_not_called()
        process.kill.assert_called_once()


if __name__ == "__main__":
    unittest.main()
