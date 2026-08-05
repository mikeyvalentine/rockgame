// Minimal DOM helpers. There is no framework here on purpose — the game screen
// is a Babylon canvas, and everything around it is a handful of static panels.

/**
 * h('button.primary', { onclick, disabled }, 'Throw')
 * Tag syntax: 'div', 'div.a.b', '.a' (implies div), 'button#go.primary'.
 * Children may be nodes, strings, numbers, or nested arrays; null/false/undefined
 * are skipped so `cond && h(...)` reads naturally.
 */
export function h(spec, props, ...children) {
  const [, tag = 'div', rest = ''] = /^([a-z0-9-]*)(.*)$/i.exec(spec) || [];
  const el = document.createElement(tag || 'div');

  for (const token of rest.match(/[.#][^.#]+/g) || []) {
    if (token[0] === '.') el.classList.add(token.slice(1));
    else el.id = token.slice(1);
  }

  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = `${el.className} ${value}`.trim();
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }

  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace everything inside `host` with `nodes`. */
export function mount(host, ...nodes) {
  host.replaceChildren();
  append(host, nodes);
  return host;
}

/** Collects teardown callbacks so a screen can be unmounted cleanly. */
export function disposers() {
  const list = [];
  const add = (fn) => (typeof fn === 'function' && list.push(fn), fn);
  add.all = () => {
    while (list.length) {
      try { list.pop()(); } catch (err) { console.error('[dispose]', err); }
    }
  };
  /** add.on(window, 'resize', fn) — registers and schedules the removal. */
  add.on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    add(() => target.removeEventListener(type, fn, opts));
  };
  return add;
}

/** 12345.6 -> '12,346'. Keeps big numbers readable in the HUD. */
export const fmt = {
  int: (n) => Math.round(Number(n) || 0).toLocaleString(),
  dec: (n, places = 1) => (Number(n) || 0).toFixed(places),
  metres: (n) => `${(Number(n) || 0).toFixed(1)} m`,
  /** Relative time, coarse on purpose — 'just now', '4h ago', '3d ago'. */
  ago(iso) {
    if (!iso) return '—';
    const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return 'just now';
    for (const [unit, size] of [['m', 60], ['h', 3600], ['d', 86400]]) {
      if (secs < size * 60 || unit === 'd') return `${Math.floor(secs / size)}${unit} ago`;
    }
    return '—';
  },
};
