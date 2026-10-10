import { startRagdollScene } from "./ragdoll.js"
import { startWindClothScene, setWindEnabled } from "./windCloth.js"
import { startClothCollisionScene } from "./clothCollision.js"
import { startClothTrampolineScene } from "./clothTrampoline.js"

// Every demo's start(mount, gravity) builds its scene paused and resolves to
// its PhyZinc instance. Adding a demo is one module plus one entry here.
// Optional `toggles` add demo-specific switches to the control panel; each
// one's apply(phyZinc, checked) runs once the scene starts and on every change.
export const DEMOS = [
  { key: 'ragdoll', label: 'Ragdoll', start: startRagdollScene },
  {
    key: 'wind-cloth',
    label: 'Wind cloth',
    start: startWindClothScene,
    toggles: [
      { key: 'wind', label: 'Wind', defaultChecked: true, apply: setWindEnabled },
    ],
  },
  { key: 'cloth-collision', label: 'Cloth collision', start: startClothCollisionScene },
  { key: 'cloth-trampoline', label: 'Cloth trampoline', start: startClothTrampolineScene },
];
