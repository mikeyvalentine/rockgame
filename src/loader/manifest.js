// What gets loaded, and when. Two queues:
//
//   bootTasks — before the menu. Must stay small; this is time the player
//               spends looking at the splash before they can do anything.
//   gameTasks — before a throw. This is where the heavy work goes: the Babylon
//               chunk, the environment, rock textures.
//
// Weights are rough relative costs, not milliseconds. Re-measure and adjust
// when real assets land — a wrong weight shows up immediately as a bar that
// stalls or sprints.

import { initSession } from '../services/session.js';

export const bootTasks = [
  {
    id: 'session',
    label: 'Waking the lake',
    weight: 3,
    run: () => initSession(),
  },
  {
    id: 'fonts',
    label: 'Setting type',
    weight: 1,
    run: async () => {
      if (!document.fonts?.ready) return null;
      // Never let a font stall the boot.
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
      return true;
    },
  },
];

// Empty until the real game lands. The placeholder engine (and the play screen
// that loaded it through this queue) was deleted when the feature labs moved
// into this repo — they now live as their own pages, linked from the menu:
//
//   rock-forge              -> procedural rock geometry + the texture set
//   rock-sift               -> shore/sifting scene
//   babylon-water           -> the water surface
//   stone-skipping-physics  -> the flight/skip solver
//   sand-sim                -> the beach
//
// Each becomes a real gameTask here as it is wired into the actual game.
// (rockgame-prototype, still on the Desktop, brings the throw meter, QTE, aim
// arc and hole rules when its turn comes.)
export const gameTasks = [];
