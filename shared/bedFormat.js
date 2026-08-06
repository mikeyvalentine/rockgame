/**
 * The baked-bed binary format. Canonical here; `rock-sift/src/bed.js` is a shim
 * over it, the way `rock-sift/src/rocks.js` shims `shared/rockRating.js`.
 *
 * It moved because two apps read beds now. rock-sift pours and sifts them;
 * sand-sim draws them on the shingle piles at standing distance. Two decoders
 * for one on-disk format is the kind of duplication that stays correct right up
 * until someone changes the quantisation.
 *
 * Deliberately Babylon-free — DataView and TextDecoder and nothing else. That
 * is not tidiness: rock-sift is on `@babylonjs/core` 8.56 and sand-sim on 9.18,
 * so anything either app imports from the other must carry no engine with it.
 * The same rule is why sand-sim generates its stones straight from the forge
 * (which is also pure JS) rather than importing rock-sift's mesh builders.
 *
 * Format notes, from the original: positions quantise into the bed's own
 * bounding box at 16 bits an axis — about 0.03 mm over a 2 m bed — and each
 * quaternion component into 16 bits, far finer than a stone's silhouette can
 * show. 15 bytes a stone. The archetype NAMES are stored rather than indices,
 * so a reordered or replaced cast is a loud failure instead of every stone
 * silently mapped to the wrong shape.
 */

export const MAGIC = 0x52534244; // "RSBD"
export const VERSION = 1;
export const HEADER_BYTES = 36;
export const STONE_BYTES = 15;

/**
 * @param {ArrayBuffer} buffer
 * @returns {{version:number, names:string[], count:number, archIndex:Uint8Array,
 *            positions:Float32Array, quaternions:Float32Array}}
 */
export function decodeBed(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0) !== MAGIC) throw new Error("not a bed file");
  const version = view.getUint16(4);
  if (version !== VERSION) throw new Error(`bed format v${version}, expected v${VERSION}`);

  const archCount = view.getUint16(6);
  const count = view.getUint32(8);
  const min = [view.getFloat32(12), view.getFloat32(16), view.getFloat32(20)];
  const max = [view.getFloat32(24), view.getFloat32(28), view.getFloat32(32)];

  const decoder = new TextDecoder();
  const names = [];
  let at = HEADER_BYTES;
  for (let i = 0; i < archCount; i++) {
    const len = view.getUint16(at);
    at += 2;
    names.push(decoder.decode(new Uint8Array(buffer, at, len)));
    at += len;
  }

  const archIndex = new Uint8Array(count);
  const positions = new Float32Array(count * 3);
  const quaternions = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    archIndex[i] = view.getUint8(at);
    at += 1;
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = min[k] + (view.getUint16(at) / 65535) * (max[k] - min[k]);
      at += 2;
    }
    let qx = view.getInt16(at) / 32767, qy = view.getInt16(at + 2) / 32767;
    let qz = view.getInt16(at + 4) / 32767, qw = view.getInt16(at + 6) / 32767;
    at += 8;
    // Renormalise: each component was rounded independently, so the quaternion
    // comes back very slightly off unit length.
    const len = Math.hypot(qx, qy, qz, qw) || 1;
    quaternions[i * 4] = qx / len;
    quaternions[i * 4 + 1] = qy / len;
    quaternions[i * 4 + 2] = qz / len;
    quaternions[i * 4 + 3] = qw / len;
  }

  return { version, names, count, archIndex, positions, quaternions };
}
