'use strict';

// Bounded teardown, as used by Chat on Steroids src/main/shutdown.ts.
// A cleanup failure must not leave an invisible process holding the instance lock.
async function finishShutdown({ tasks, log, exit, timeoutMs = 8000 }) {
  let timer;
  try {
    const work = Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
    const results = await Promise.race([
      work,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })
    ]);
    if (!results) log.warn('退出清理超过时限，将结束助手进程');
    else for (const result of results) if (result.status === 'rejected') log.warn('退出清理失败', { error: String(result.reason?.message || result.reason) });
  } finally {
    clearTimeout(timer);
    exit();
  }
}

module.exports = { finishShutdown };
