// How big is each stone?
//
// Sediment does not come in a narrow band of sizes, and drawing uniformly from
// one is what makes a generated bed read as manufactured. Real clast sizes are
// log-normal, and sedimentology has a standard way of saying so: the phi scale,
//
//     phi = -log2(d in mm)
//
// on which grain sizes are approximately *normally* distributed. The standard
// deviation in phi has a name — **sorting** — and it is the single number that
// distinguishes environments. A wave-worked beach is well sorted, because the
// surf repeatedly removes anything that does not belong; a river bed is poorly
// sorted, because floods dump everything at once. Folk's verbal scale:
//
//     sigma < 0.35   very well sorted     (a storm beach ridge)
//     0.35 - 0.50    well sorted          (most shingle beaches)
//     0.50 - 1.00    moderately sorted    (a pond margin)
//     1.00 - 2.00    poorly sorted        (an active river bed)
//     > 2.00         very poorly sorted   (glacial till, debris flow)
//
// One phi unit is a factor of two in diameter, so sigma = 1.5 means the middle
// two thirds of the stones span roughly an eightfold range — a bed with cobbles
// sitting among granules, which is exactly what a river bed looks like and what
// a uniform draw can never produce.

/** Box-Muller. Returns a standard normal deviate. */
export function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();          // log(0) is not a number we want
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Wentworth grade names, coarse to fine. Diameters in metres. */
export const WENTWORTH = [
  { name: "boulder", min: 0.256 },
  { name: "cobble", min: 0.064 },
  { name: "pebble", min: 0.004 },
  { name: "granule", min: 0.002 },
  { name: "sand", min: 0 },
];

export const gradeOf = (d) => WENTWORTH.find((g) => d >= g.min).name;

/**
 * Draw one clast diameter, in metres.
 *
 * @param {() => number} rng
 * @param {object} opts
 * @param {number} opts.median   median diameter in metres
 * @param {number} opts.sorting  standard deviation in phi units — see above
 * @param {number} opts.bias     per-archetype multiplier on the median
 * @param {[number,number]} opts.clamp  hard limits in metres
 */
export function drawSize(rng, { median, sorting, bias = 1, clamp = [0.006, 0.45] }) {
  // phi is negative log2 of diameter, so a positive deviate must *shrink* the
  // stone. Getting this sign wrong is invisible in a histogram's width and
  // obvious in the mean.
  const d = median * bias * Math.pow(2, -sorting * gaussian(rng));
  return Math.min(clamp[1], Math.max(clamp[0], d));
}

/**
 * A bed is dominated by small stones *by number* and by large ones *by area*,
 * and those two facts pull the eye in opposite directions. Reporting both stops
 * a distribution that is numerically correct from looking wrong on screen.
 */
export function sizeReport(sizes) {
  const byCount = {};
  const byArea = {};
  let area = 0;
  for (const d of sizes) {
    const g = gradeOf(d);
    byCount[g] = (byCount[g] || 0) + 1;
    const a = Math.PI * (d / 2) ** 2;
    byArea[g] = (byArea[g] || 0) + a;
    area += a;
  }
  const sorted = [...sizes].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    n: sizes.length,
    min: sorted[0], max: sorted[sorted.length - 1],
    d10: q(0.10), median: q(0.50), d90: q(0.90),
    byCount,
    byArea: Object.fromEntries(Object.entries(byArea).map(([k, v]) => [k, v / area])),
  };
}
