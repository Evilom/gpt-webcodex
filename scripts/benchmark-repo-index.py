"""Compare v0.9.32 with the fix using isolated copies of real repository text."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import time

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'resources/coding-tools-mcp'))
from coding_tools_mcp.repo_index import RepoIndex

legacy = {'__name__': 'legacy_repo_index'}
exec(compile(subprocess.check_output(['git', 'show', 'v0.9.32:resources/coding-tools-mcp/coding_tools_mcp/repo_index.py'], cwd=ROOT), '<v0.9.32/repo_index.py>', 'exec'), legacy)
sources = {}
for name in subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0'):
    path = ROOT / name
    if path.suffix not in {'.py', '.js', '.ts', '.tsx', '.md'} or not path.is_file():
        continue
    sources[name] = path.read_bytes()
changed = [name for name in sources if Path(name).suffix in {'.py', '.js'}][:50]
removed = [name for name in sources if name not in changed][:10]


def measured(connection, action):
    ticks = 0

    def progress():
        nonlocal ticks
        ticks += 1

    connection.set_progress_handler(progress, 1000)
    started = time.perf_counter()
    action()
    connection.commit()
    elapsed = time.perf_counter() - started
    connection.set_progress_handler(None, 0)
    return {'milliseconds': round(elapsed * 1000, 2), 'sqlite_vm_steps_approx': ticks * 1000}


with TemporaryDirectory(prefix='repo-index-real-source-') as temp:
    base = Path(temp)
    report = {'source_files': len(sources), 'source_bytes': sum(map(len, sources.values())), 'real_repository_incremental': {}, 'scaled_sql': {}}
    for label, implementation in [('v0.9.32', legacy['RepoIndex']), ('fixed', RepoIndex)]:
        root = base / label
        for name, data in sources.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        index = implementation(root)
        assert index.sync()['ok']
        for name in changed:
            with (root / name).open('ab') as output:
                output.write(b'\n# index_incremental_probe\n' if name.endswith('.py') else b'\n// index_incremental_probe\n')
        for name in removed:
            (root / name).unlink()
        started = time.perf_counter()
        result = index.sync()
        milliseconds = (time.perf_counter() - started) * 1000
        assert result['updated'] == len(changed) and result['removed'] == len(removed), result
        assert len(index.search('index_incremental_probe', limit=100)) == len(changed)
        report['real_repository_incremental'][label] = {'milliseconds': round(milliseconds, 2), 'updated': result['updated'], 'removed': result['removed'], 'file_count': result['file_count']}

    # Scale the faulty SQL operation with actual source text, without scanning
    # or changing the user's live projects or their index databases.
    index = RepoIndex(base / 'fixed')
    text = [data.decode('utf-8', errors='replace')[:16384] for data in sources.values()]
    rows = 6000
    with closing(sqlite3.connect(base / 'seed.db')) as seed:
        seed.execute("CREATE VIRTUAL TABLE files_fts USING fts5(path UNINDEXED, content, tokenize='unicode61')")
        seed.execute('CREATE TABLE file_fts_rows(path TEXT PRIMARY KEY, fts_rowid INTEGER NOT NULL)')
        for number in range(rows):
            path = f'source/{number:05}.txt'
            row = seed.execute('INSERT INTO files_fts(path,content) VALUES(?,?)', (path, text[number % len(text)]))
            seed.execute('INSERT INTO file_fts_rows VALUES(?,?)', (path, row.lastrowid))
            if (number + 1) % 128 == 0:
                seed.commit()
        seed.commit()
        for label in ['v0.9.32', 'fixed']:
            with closing(sqlite3.connect(base / (label + '.db'))) as connection:
                seed.backup(connection)
                def run():
                    for number in range(100):
                        path = f'source/{number:05}.txt'
                        if label == 'fixed':
                            index._delete_fts(connection, path)
                        else:
                            connection.execute('DELETE FROM files_fts WHERE path=?', (path,))
                report['scaled_sql'][label] = measured(connection, run)
                assert connection.execute('SELECT COUNT(*) FROM files_fts').fetchone()[0] == rows - 100
                report['scaled_sql'][label]['query_plan'] = [row[3] for row in connection.execute('EXPLAIN QUERY PLAN ' + ('SELECT fts_rowid FROM file_fts_rows WHERE path=?' if label == 'fixed' else 'DELETE FROM files_fts WHERE path=?'), ('source/00000.txt',))]
    report['scaled_sql'].update({'rows': rows, 'deletions': 100})
    report['note'] = 'Real tracked-source copies plus scaled SQL with real text. Warm-cache wall time and VM steps, not physical disk I/O or a long-duration production load test. No live index was changed.'
    output = ROOT / 'build/index-efficiency-benchmark.json'
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
