from __future__ import annotations

import json
import os
from contextlib import closing
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

from coding_tools_mcp import repo_index, server
from coding_tools_mcp.repo_index import RepoIndex


class RepoIndexEfficiencyTests(unittest.TestCase):
    def test_updates_and_deletions_use_mapped_rowids(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            for number in range(150):
                (root / f"file{number:03}.py").write_text(f"marker_{number} = {number}\n", encoding="utf-8")
            index = RepoIndex(root)
            index.sync()
            statements = []
            connect = index._connect

            def traced():
                connection = connect()
                connection.set_trace_callback(statements.append)
                return connection

            (root / 'file000.py').write_text('replacement_marker = True\n', encoding='utf-8')
            (root / 'file001.py').unlink()
            with patch.object(index, '_connect', traced):
                result = index.sync()
            self.assertEqual((result['updated'], result['removed']), (1, 1))
            self.assertFalse(any('DELETE FROM files_fts WHERE path' in item for item in statements))
            self.assertTrue(any('DELETE FROM files_fts WHERE rowid=' in item for item in statements))
            self.assertEqual(index.search('marker_0'), [])
            self.assertEqual(index.search('marker_1'), [])
            self.assertEqual(index.search('replacement_marker')[0]['path'], 'file000.py')
            with closing(sqlite3.connect(index.db_path)) as connection:
                plan = connection.execute('EXPLAIN QUERY PLAN SELECT fts_rowid FROM file_fts_rows WHERE path=?', ('file000.py',)).fetchall()
                self.assertIn('SEARCH file_fts_rows USING INDEX', str(plan))
                self.assertEqual(connection.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM file_fts_rows').fetchone()[0], 149)

    def test_legacy_migration_preserves_fts_identity_and_content(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'old.py').write_text('legacy_marker = True\n', encoding='utf-8')
            index = RepoIndex(root)
            index.sync()
            with closing(sqlite3.connect(index.db_path)) as connection:
                original = connection.execute('SELECT rowid, path, content FROM files_fts').fetchall()
                connection.execute('DROP TABLE file_fts_rows')  # Original on-disk schema.
            result = RepoIndex(root).sync()
            self.assertFalse(result['rebuilt'])
            with closing(sqlite3.connect(index.db_path)) as connection:
                self.assertEqual(connection.execute('SELECT rowid, path, content FROM files_fts').fetchall(), original)
                self.assertEqual(connection.execute('SELECT path, fts_rowid FROM file_fts_rows').fetchall(), [(original[0][1], original[0][0])])

    def test_migration_failure_rolls_back_table_and_can_retry(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'old.py').write_text('preserved_marker = True\n', encoding='utf-8')
            index = RepoIndex(root)
            index.sync()
            with closing(sqlite3.connect(index.db_path)) as connection:
                connection.execute('DROP TABLE file_fts_rows')
            connect = sqlite3.connect

            class InterruptedMigration(sqlite3.Connection):
                def execute(self, sql, parameters=()):
                    if sql.startswith('INSERT INTO file_fts_rows SELECT'):
                        raise RuntimeError('simulated migration interruption')
                    return super().execute(sql, parameters)

            with patch.object(repo_index.sqlite3, 'connect', lambda *a, **kw: connect(*a, **kw, factory=InterruptedMigration)):
                with self.assertRaisesRegex(RuntimeError, 'migration interruption'):
                    index._connect()
            with closing(connect(index.db_path)) as connection:
                self.assertIsNone(connection.execute("SELECT 1 FROM sqlite_master WHERE name='file_fts_rows'").fetchone())
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM files_fts').fetchone()[0], 1)
            self.assertFalse(index.sync()['rebuilt'])
            self.assertEqual(index.search('preserved_marker')[0]['path'], 'old.py')

    def test_interrupted_batch_reconciles_rows_missing_from_manifest(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            for number in range(130):
                (root / f'file{number:03}.py').write_text(f'marker_{number} = True\n', encoding='utf-8')
            index = RepoIndex(root)
            decode = repo_index._safe_decode
            calls = 0

            def interrupted(data):
                nonlocal calls
                calls += 1
                if calls == 129:
                    raise RuntimeError('simulated batch interruption')
                return decode(data)

            with patch.object(repo_index, '_safe_decode', interrupted):
                with self.assertRaisesRegex(RuntimeError, 'batch interruption'):
                    index.sync()
            self.assertFalse(index.manifest_path.exists())
            with closing(sqlite3.connect(index.db_path)) as connection:
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM files').fetchone()[0], 128)
            (root / 'file000.py').unlink()
            self.assertTrue(index.sync()['ok'])
            self.assertEqual(index.search('marker_0'), [])
            with closing(sqlite3.connect(index.db_path)) as connection:
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM files_fts').fetchone()[0], 129)
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM file_fts_rows').fetchone()[0], 129)

    def test_bulk_removals_commit_in_batches(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            for number in range(130):
                (root / f'file{number:03}.py').write_text('value = True\n', encoding='utf-8')
            index = RepoIndex(root)
            index.sync()
            for source in root.glob('*.py'):
                source.unlink()
            statements = []
            connect = index._connect

            def traced():
                connection = connect()
                connection.set_trace_callback(statements.append)
                return connection

            with patch.object(index, '_connect', traced):
                self.assertEqual(index.sync()['removed'], 130)
            self.assertGreaterEqual(statements.count('COMMIT'), 2)

    def test_disabled_container_policy_does_not_open_index_or_disable_child(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            child = root / 'individual-project'
            child.mkdir()
            policy = root / '.coding-tools' / 'index-policy.json'
            policy.parent.mkdir()
            policy.write_text(json.dumps({'background_enabled': False}), encoding='utf-8')
            with patch.object(RepoIndex, '_connect', side_effect=AssertionError('must not open aggregate index')):
                payload = server._repo_map_snapshot(root, 'compact')
                self.assertEqual(payload['index_status']['status'], 'disabled')
                self.assertFalse(payload['_refresh_needed'])
                self.assertFalse(server._start_repo_index_refresh(root, 'policy-test', 'compact'))
            self.assertTrue(RepoIndex(child).background_enabled())
            self.assertFalse(RepoIndex(root).db_path.exists())

    def test_context_refresh_waits_five_minutes(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'app.py').write_text('value = True\n', encoding='utf-8')
            index = RepoIndex(root)
            index.sync()
            for age, expected in [(120, False), (360, True)]:
                stamp = time.time() - age
                os.utime(index.manifest_path, (stamp, stamp))
                self.assertEqual(server._repo_map_snapshot(root, 'compact')['_refresh_needed'], expected)
