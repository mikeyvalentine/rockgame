// Bake a terrain MESH into a height grid — the bridge that lets an authored
// glb be the world's ground instead of the procedural beach profile.
//
// The whole engine grounds and displaces through one representation: a square
// Float32 grid of heights that `heightAt(x, z)` samples (see
// sand-sim/src/terrain/heightfield.js). Feed that grid from a mesh and walking,
// rock scatter, the water's shore line and sand deformation all adapt to the
// mesh with no further wiring — and re-exporting the glb and re-baking moves
// the whole world with it, which is the point.
//
// Engine-agnostic on purpose: plain typed arrays in, plain grid out, no
// Babylon. That lets `tools/glb-heightfield-check.mjs` bake the real glb in
// node with no GPU, and lets both the WebGL and WebGPU paths share one bake.
//
// Two robustness jobs the raw mesh forces:
//   - HOLES. An authored terrain is not a closed heightfield: triangles do not
//     cover every (x, z), and where the DCC left gaps (or outside the mesh) the
//     grid must be filled rather than left as pits. Nearest-valid fill.
//   - SPIKES. C4D landscape generation left noisy cavity geometry at the pond
//     centre (measured -77 m to +85 m within 10 m of centre); it is under the
//     water and slated for retopo, but a +85 m spike would poke through the
//     surface. Heights are clamped to a sane band so a stray vertex cannot.

/**
 * Rasterize mesh triangles into a height grid.
 *
 * @param {object} a
 * @param {Float32Array|number[]} a.positions  flat local xyz per vertex
 * @param {Uint16Array|Uint32Array|number[]} a.indices  triangle list
 * @param {{x:number,y:number,z:number}} [a.offset]  added to every vertex (world placement)
 * @param {{x:number,z:number}} a.origin  world position of grid cell (0,0)
 * @param {number} a.size  world metres spanned by the grid
 * @param {number} a.res  cells per side
 * @param {number} a.clampLo  floor heights to this (kills downward spikes)
 * @param {number} a.clampHi  ceil heights to this (kills upward spikes)
 * @returns {{grid:Float32Array, res:number, origin:{x:number,z:number}, size:number,
 *            filled:number, min:number, max:number}}
 */
export function bakeHeightGrid({
    positions, indices, offset = { x: 0, y: 0, z: 0 },
    origin, size, res, clampLo = -8, clampHi = 30, pick = "high",
}) {
    const keepHigher = pick !== "low";
    const grid = new Float32Array(res * res).fill(NaN);
    const cell = size / res;
    const ox = origin.x, oz = origin.z;

    // World (x,z) -> continuous grid coords.
    const gx = (x) => ((x - ox) / size) * res;
    const gz = (z) => ((z - oz) / size) * res;

    const tri = indices.length;
    for (let t = 0; t < tri; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        const ax = positions[a] + offset.x, ay = positions[a + 1] + offset.y, az = positions[a + 2] + offset.z;
        const bx = positions[b] + offset.x, by = positions[b + 1] + offset.y, bz = positions[b + 2] + offset.z;
        const cx = positions[c] + offset.x, cy = positions[c + 1] + offset.y, cz = positions[c + 2] + offset.z;

        // Grid-space triangle, with a half-cell shift so a sample at grid index
        // i lands at the cell CENTRE (matching heightAt's reconstruction).
        const gax = gx(ax) - 0.5, gaz = gz(az) - 0.5;
        const gbx = gx(bx) - 0.5, gbz = gz(bz) - 0.5;
        const gcx = gx(cx) - 0.5, gcz = gz(cz) - 0.5;

        let minX = Math.floor(Math.min(gax, gbx, gcx));
        let maxX = Math.ceil(Math.max(gax, gbx, gcx));
        let minY = Math.floor(Math.min(gaz, gbz, gcz));
        let maxY = Math.ceil(Math.max(gaz, gbz, gcz));
        if (maxX < 0 || minX >= res || maxY < 0 || minY >= res) continue;
        minX = Math.max(minX, 0); maxX = Math.min(maxX, res - 1);
        minY = Math.max(minY, 0); maxY = Math.min(maxY, res - 1);

        const d = (gbz - gcz) * (gax - gcx) + (gcx - gbx) * (gaz - gcz);
        if (Math.abs(d) < 1e-12) continue; // degenerate in the xz plane
        const invD = 1 / d;

        for (let iy = minY; iy <= maxY; iy++) {
            for (let ix = minX; ix <= maxX; ix++) {
                const px = ix, py = iy;
                const w0 = ((gbz - gcz) * (px - gcx) + (gcx - gbx) * (py - gcz)) * invD;
                const w1 = ((gcz - gaz) * (px - gcx) + (gax - gcx) * (py - gcz)) * invD;
                const w2 = 1 - w0 - w1;
                if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
                let h = w0 * ay + w1 * by + w2 * cy;
                if (h < clampLo) h = clampLo; else if (h > clampHi) h = clampHi;
                const idx = py * res + ix;
                // Tie-break where triangles overlap in xz. 'high' reads a bank
                // lip over its undercut; 'low' reads the pond floor under noisy
                // cavity geometry.
                if (Number.isNaN(grid[idx]) ||
                    (keepHigher ? h > grid[idx] : h < grid[idx])) grid[idx] = h;
            }
        }
    }

    const filled = fillHoles(grid, res);

    let min = Infinity, max = -Infinity;
    for (let i = 0; i < grid.length; i++) {
        if (grid[i] < min) min = grid[i];
        if (grid[i] > max) max = grid[i];
    }
    return { grid, res, origin: { x: ox, z: oz }, size, filled, min, max };
}

/**
 * Fill NaN cells (mesh gaps and everything outside the mesh) from the nearest
 * written cell, by a two-pass jump flood. Cheap, and it means heightAt never
 * returns a hole. Returns the count of cells that had real data.
 */
function fillHoles(grid, res) {
    const n = res * res;
    let real = 0;
    for (let i = 0; i < n; i++) if (!Number.isNaN(grid[i])) real++;
    if (real === 0 || real === n) return real;

    // Nearest-source per cell, propagated at decreasing step sizes (JFA).
    const src = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) if (!Number.isNaN(grid[i])) src[i] = i;

    const sx = (s) => s % res, sy = (s) => (s / res) | 0;
    let step = 1;
    while (step < res) step <<= 1;
    for (; step >= 1; step >>= 1) {
        for (let y = 0; y < res; y++) {
            for (let x = 0; x < res; x++) {
                const i = y * res + x;
                let best = src[i];
                let bestD = best < 0 ? Infinity : (x - sx(best)) ** 2 + (y - sy(best)) ** 2;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx * step, ny = y + dy * step;
                        if (nx < 0 || ny < 0 || nx >= res || ny >= res) continue;
                        const s = src[ny * res + nx];
                        if (s < 0) continue;
                        const dd = (x - sx(s)) ** 2 + (y - sy(s)) ** 2;
                        if (dd < bestD) { bestD = dd; best = s; }
                    }
                }
                src[i] = best;
            }
        }
    }
    for (let i = 0; i < n; i++) if (Number.isNaN(grid[i]) && src[i] >= 0) grid[i] = grid[src[i]];
    return real;
}

/**
 * Bilinear height sampler over a baked grid, clamped at the edges. Matches the
 * cell-centre convention the bake writes with.
 */
export function makeHeightSampler({ grid, res, origin, size }) {
    const cell = size / res;
    const at = (ix, iz) => {
        if (ix < 0) ix = 0; else if (ix > res - 1) ix = res - 1;
        if (iz < 0) iz = 0; else if (iz > res - 1) iz = res - 1;
        return grid[iz * res + ix];
    };
    return {
        heightAt(x, z) {
            const fx = ((x - origin.x) / size) * res - 0.5;
            const fz = ((z - origin.z) / size) * res - 0.5;
            const ix = Math.floor(fx), iz = Math.floor(fz);
            const tx = fx - ix, tz = fz - iz;
            const h00 = at(ix, iz), h10 = at(ix + 1, iz);
            const h01 = at(ix, iz + 1), h11 = at(ix + 1, iz + 1);
            return (h00 * (1 - tx) + h10 * tx) * (1 - tz) +
                   (h01 * (1 - tx) + h11 * tx) * tz;
        },
        normalAt(x, z, out) {
            const e = cell;
            const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
            const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
            out.set(-hx / (2 * e), 1, -hz / (2 * e));
            out.normalize();
            return out;
        },
    };
}
