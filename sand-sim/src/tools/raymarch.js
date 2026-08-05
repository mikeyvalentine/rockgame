/**
 * March a ray against the CPU heightfield. Shared by the mask brush and the
 * dig tool — one marcher, one idea of "where the ray meets the sand".
 */

/**
 * @param {{origin: {x,y,z}, direction: {x,y,z}}} ray
 * @param {(x:number, z:number) => number} heightAt
 * @param {number} maxDist metres
 * @returns {{x:number, y:number, z:number}|null}
 */
export function marchHeightfield(ray, heightAt, maxDist) {
    const o = ray.origin;
    const d = ray.direction;

    let t = 0;
    let prevT = 0;
    for (let i = 0; i < 160 && t < maxDist; i++) {
        const x = o.x + d.x * t;
        const y = o.y + d.y * t;
        const z = o.z + d.z * t;
        const dy = y - heightAt(x, z);
        if (dy <= 0) {
            // Bisect between the last above-ground sample and this one.
            let lo = prevT;
            let hi = t;
            for (let k = 0; k < 8; k++) {
                const mid = (lo + hi) * 0.5;
                const my = o.y + d.y * mid - heightAt(o.x + d.x * mid, o.z + d.z * mid);
                if (my <= 0) hi = mid;
                else lo = mid;
            }
            const ft = (lo + hi) * 0.5;
            return {
                x: o.x + d.x * ft,
                y: o.y + d.y * ft,
                z: o.z + d.z * ft,
            };
        }
        prevT = t;
        // Step proportional to clearance — fast over open ground, fine near it.
        t += Math.min(2.0, Math.max(0.08, dy * 0.7));
    }
    return null;
}
