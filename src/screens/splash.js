// The splash owns the #boot element that index.html painted, runs the boot
// queue behind it, then hands over to the router. It is not a router screen —
// it happens once, before routing starts.

import { h, mount } from '../lib/dom.js';
import { progressBar } from './ui.js';
import { createLoadQueue } from '../loader/loadQueue.js';
import { bootTasks } from '../loader/manifest.js';
import { store } from '../lib/store.js';

export async function runSplash() {
  const boot = document.getElementById('boot');
  const bar = progressBar();

  mount(boot,
    h('.boot-inner', {},
      h('.boot-mark', {}, 'rockgame'),
      h('p.boot-tag', {}, 'Daily stone-skipping challenge'),
      bar.node,
      h('p.boot-backend', {}, ''),
    ),
  );

  const backendNote = boot.querySelector('.boot-backend');

  const queue = createLoadQueue(bootTasks, {
    // Long enough that the splash reads as intentional rather than a flicker.
    minMs: 700,
    onProgress: ({ progress, label }) => bar.set(progress, label),
  });

  const results = await queue.run();

  // A boot failure is worth showing rather than swallowing — without a session
  // nothing downstream works, and a silent failure looks like a hung splash.
  const failure = results.errors?.[0];
  if (failure) {
    store.set({ error: failure.message });
    bar.set(1, 'Something went wrong');
  }

  backendNote.textContent = store.get('backend') === 'local'
    ? 'No Supabase credentials — running on local storage'
    : '';

  await fadeOut(boot);
  boot.remove();

  return results;
}

function fadeOut(el) {
  return new Promise((resolve) => {
    el.classList.add('is-leaving');
    const finish = () => resolve();
    el.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 600); // in case transitions are disabled
  });
}
