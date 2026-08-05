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
    // Was `panel-stars`. The element is reused as the rarity slot — the id stayed
    // put so the stylesheet did not have to move for a text change.
    panelRarity: el("panel-stars"),
    panelVerdict: el("panel-verdict"),
    stat: {
      mass: el("stat-mass"),
      size: el("stat-size"),
      flatness: el("stat-flatness"),
      roundness: el("stat-roundness"),
      balance: el("stat-balance"),
    },
  };

  let bestScore = 0;
  let keptShown = -1;

  // Pips, not numerals. docs/02-gathering.md wants inspection to stay a judgement
  // call — "stat bars, not numbers... deliberately slightly ambiguous" — so the
  // player sees how full a bar is and never the score behind it.
  const pips = (n) => "●".repeat(n) + "○".repeat(5 - n);
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
      // Per-stat pips. Each one is closeness to the ideal skipping stone, so they
      // all read the same way round: a boulder scores empty on mass and a pebble
      // scores empty on mass too, from the opposite side.
      for (const k of Object.keys(nodes.stat)) {
        if (nodes.stat[k]) nodes.stat[k].textContent = pips(r.pips[k]);
      }
      // Rarity, not a score: the player gets a colour and a word.
      if (nodes.panelRarity) {
        nodes.panelRarity.textContent = r.rarity.label;
        nodes.panelRarity.style.color = r.rarity.color;
      }
      // Tint the stone's name too, so the tier reads at a glance.
      nodes.panelName.style.color = r.rarity.color;
      nodes.panelVerdict.textContent = r.verdict;
      nodes.panel.classList.add("visible");
      nodes.hint.classList.add("hidden");

      if (r.score > bestScore) {
        bestScore = r.score;
        nodes.best.textContent = `${r.rarity.label} (${metrics.sortedCm[0].toFixed(1)} cm)`;
        nodes.best.style.color = r.rarity.color;
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
