// Weighted load queue. The point of the weights is that a progress bar which
// jumps 0 → 90% on one task and then sits there is worse than no bar at all:
// each task declares roughly how long it costs relative to the others, and a
// task that can report sub-progress (a fetch with a known length) does.
//
// No DOM in here, so tools/loader-test.mjs can run it under Node.

/**
 * @param {Array<{id: string, label?: string, weight?: number, run: (report: (f: number) => void, results: object) => any}>} tasks
 * @param {{ onProgress?: (p: {progress: number, label: string, id: string}) => void, minMs?: number }} opts
 */
export function createLoadQueue(tasks, { onProgress, minMs = 0 } = {}) {
  const list = tasks.map((t) => ({ weight: 1, label: t.id, ...t }));
  const total = list.reduce((sum, t) => sum + t.weight, 0) || 1;
  const done = new Map(list.map((t) => [t.id, 0]));

  let current = list[0]?.label ?? '';
  let currentId = list[0]?.id ?? '';

  function emit() {
    const sum = [...done.values()].reduce((a, b) => a + b, 0);
    onProgress?.({
      progress: Math.min(1, sum / total),
      label: current,
      id: currentId,
    });
  }

  async function run() {
    const started = now();
    const results = {};
    emit();

    for (const task of list) {
      current = task.label;
      currentId = task.id;
      emit();

      const report = (fraction) => {
        done.set(task.id, task.weight * clamp01(fraction));
        emit();
      };

      try {
        results[task.id] = await task.run(report, results);
      } catch (err) {
        // A failed task must not strand the bar. Record it and carry on —
        // the caller decides whether a given failure is fatal.
        err.taskId = task.id;
        results[task.id] = undefined;
        (results.errors ??= []).push(err);
      }

      done.set(task.id, task.weight);
      emit();
    }

    // Stop the splash flashing past on a warm cache.
    const remaining = minMs - (now() - started);
    if (remaining > 0) await sleep(remaining);

    return results;
  }

  return { run, get progress() { return [...done.values()].reduce((a, b) => a + b, 0) / total; } };
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Fetch with real progress when the server sends Content-Length, and a single
 * 0 → 1 step when it doesn't. Returns an ArrayBuffer.
 */
export async function fetchWithProgress(url, report = () => {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${url}`);

  const length = Number(response.headers.get('content-length')) || 0;
  if (!length || !response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    report(1);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    report(received / length);
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out.buffer;
}
