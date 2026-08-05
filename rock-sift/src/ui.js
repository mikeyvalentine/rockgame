// The HUD. Pure DOM — nothing in here knows what Babylon is.

const el = (id) => document.getElementById(id);

export function createHud() {
  const nodes = {
    loading: el("loading"),
    loadingText: el("loading-text"),
    hint: el("hint"),
    depth: el("depth"),
    best: el("best"),
    kept: el("kept"),
    panel: el("panel"),
    panelName: el("panel-name"),
    panelDims: el("panel-dims"),
    panelMass: el("panel-mass"),
    panelStars: el("panel-stars"),
    panelVerdict: el("panel-verdict"),
  };

  let bestScore = 0;
  let keptShown = -1;

  const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);
  const grams = (g) => (g < 1000 ? `${Math.round(g)} g` : `${(g / 1000).toFixed(2)} kg`);

  return {
    setStatus(text) {
      if (nodes.loadingText) nodes.loadingText.textContent = text;
    },

    hideLoading() {
      nodes.loading.classList.add("hidden");
    },

    /** @param metres how deep the sweep is riding */
    setDepth(metres) {
      nodes.depth.textContent = `${(metres * 100).toFixed(1)} cm`;
    },

    /** Show the readout for a stone that has just been picked up. */
    showStone(metrics) {
      const r = metrics.rating;
      nodes.panelName.textContent = metrics.label;
      nodes.panelDims.textContent = metrics.sortedCm.map((v) => v.toFixed(1)).join(" × ") + " cm";
      nodes.panelMass.textContent = grams(metrics.massGrams);
      nodes.panelStars.textContent = stars(r.stars);
      nodes.panelVerdict.textContent = r.verdict;
      nodes.panel.classList.add("visible");
      nodes.hint.classList.add("hidden");

      if (r.score > bestScore) {
        bestScore = r.score;
        nodes.best.textContent = `${stars(r.stars)} (${metrics.sortedCm[0].toFixed(1)} cm)`;
      }
    },

    /** How many stones are sitting in the bucket. */
    setKept(n) {
      // Assigning textContent every frame dirties layout for a value that
      // changes a handful of times a session.
      if (!nodes.kept || n === keptShown) return;
      keptShown = n;
      nodes.kept.textContent = String(n);
    },

    setHint(html) {
      nodes.hint.innerHTML = html;
    },

    hideStone() {
      nodes.panel.classList.remove("visible");
      nodes.hint.classList.remove("hidden");
    },
  };
}
