import { startRagdollScene } from "./ragdoll.js"
import { startWindClothScene } from "./windCloth.js"
import { startClothCollisionScene } from "./clothCollision.js"

// Every demo's start(mount, gravity) builds its scene paused and resolves to
// its PhyZinc instance. Adding a demo is one module plus one entry here.
export const DEMOS = [
  { key: 'ragdoll', label: 'Ragdoll', start: startRagdollScene },
  { key: 'wind-cloth', label: 'Wind cloth', start: startWindClothScene },
  { key: 'cloth-collision', label: 'Cloth collision', start: startClothCollisionScene },
];
