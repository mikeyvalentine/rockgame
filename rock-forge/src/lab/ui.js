// Minimal control panel + HUD. No framework: this is a lab, and a build step
// for the UI would outweigh the UI.

export function panel(root) {
  const api = { el: root };

  const row = (label) => {
    const d = document.createElement("div");
    d.className = "row";
    if (label) {
      const l = document.createElement("label");
      l.textContent = label;
      d.appendChild(l);
    }
    root.appendChild(d);
    return d;
  };

  api.section = (title) => {
    const h = document.createElement("h3");
    h.textContent = title;
    root.appendChild(h);
    return api;
  };

  api.slider = (label, { min, max, step = 1, value, format = String, onChange }) => {
    const d = row(label);
    const out = document.createElement("span");
    out.className = "val";
    const s = document.createElement("input");
    s.type = "range";
    Object.assign(s, { min, max, step, value });
    out.textContent = format(value);
    s.addEventListener("input", () => {
      const v = parseFloat(s.value);
      out.textContent = format(v);
      onChange(v);
    });
    d.appendChild(s);
    d.appendChild(out);
    return { set: (v) => { s.value = v; out.textContent = format(v); } };
  };

  api.select = (label, { options, value, onChange }) => {
    const d = row(label);
    const s = document.createElement("select");
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = typeof o === "string" ? o : o.value;
      opt.textContent = typeof o === "string" ? o : o.label;
      s.appendChild(opt);
    }
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
    d.appendChild(s);
    return { set: (v) => { s.value = v; } };
  };

  api.toggle = (label, { value, onChange }) => {
    const d = row("");
    const id = "t" + Math.random().toString(36).slice(2);
    const c = document.createElement("input");
    c.type = "checkbox"; c.checked = value; c.id = id;
    const l = document.createElement("label");
    l.htmlFor = id; l.textContent = label; l.className = "cb";
    c.addEventListener("change", () => onChange(c.checked));
    d.appendChild(c); d.appendChild(l);
    return { set: (v) => { c.checked = v; } };
  };

  api.button = (label, onClick) => {
    const d = row("");
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => onClick(b));
    d.appendChild(b);
    return b;
  };

  api.note = (text) => {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = text;
    root.appendChild(p);
    return p;
  };

  return api;
}

export function hud(root) {
  const lines = new Map();
  return {
    set(key, value) {
      let el = lines.get(key);
      if (!el) {
        el = document.createElement("div");
        el.className = "hudline";
        el.innerHTML = `<span class="k"></span><span class="v"></span>`;
        el.querySelector(".k").textContent = key;
        root.appendChild(el);
        lines.set(key, el);
      }
      el.querySelector(".v").textContent = value;
    },
    clear() { root.innerHTML = ""; lines.clear(); },
  };
}

export function showError(err) {
  const box = document.getElementById("err");
  box.hidden = false;
  box.textContent = String(err && err.stack ? err.stack : err);
}
