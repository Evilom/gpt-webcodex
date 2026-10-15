from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from coding_tools_mcp import server as server_module
from coding_tools_mcp.server import Runtime, matches_any_glob


class GlobstarMatchingTests(unittest.TestCase):
    def test_globstar_matches_zero_or_more_directories(self) -> None:
        cases = [
            ("src/m.py", "src/**/*.py", True),
            ("src/deep/er/d.py", "src/**/*.py", True),
            ("root.py", "**/*.py", True),
            ("src/m.py", "**/*.py", True),
            ("a/x.py", "**/a/**/*.py", True),
            ("src/m.txt", "src/**/*.py", False),
            ("other/m.py", "src/**/*.py", False),
            ("x.py", "**/a/**/*.py", False),
        ]
        for rel, pattern, expected in cases:
            with self.subTest(rel=rel, pattern=pattern):
                self.assertIs(matches_any_glob(rel, [pattern]), expected)

    def test_python_fallback_lists_and_searches_direct_children(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "src" / "deep").mkdir(parents=True)
            for rel in ("root.py", "src/m.py", "src/deep/d.py"):
                (root / rel).write_text("def example():\n    pass\n", encoding="utf-8")
            runtime = Runtime(root)
            runtime.workspace.git_path = None
            try:
                with patch.object(server_module, "cached_which", return_value=None):
                    listed = runtime.list_files({"glob": "src/**/*.py"})
                    all_python = runtime.list_files({"glob": "**/*.py"})
                    found = runtime.search_text({"query": "def example", "include_globs": ["src/**/*.py"]})
                    excluded = runtime.search_text({"query": "def example", "exclude_globs": ["src/**/*.py"]})
            finally:
                runtime.close()
        self.assertEqual([item["path"] for item in listed["files"]], ["src/deep/d.py", "src/m.py"])
        self.assertEqual([item["path"] for item in all_python["files"]], ["root.py", "src/deep/d.py", "src/m.py"])
        self.assertEqual(found["total_matches"], 2)
        self.assertEqual(excluded["total_matches"], 1)


if __name__ == "__main__":
    unittest.main()
