import Zinc from "zincjs";
import { PhyZinc } from "../../phyZinc.js"
import { ClothPatch, ClothOptions } from "../../physics/pbdCloth.js"

// WebGPU XPBD cloth curtain pinned at its top corners, blown by gusty wind.
// Self-contained, no Rapier: never calls phyZinc.initialise() (which loads the
// Rapier WASM module), only PhyZinc's generic rendering setup.
export async function startWindClothScene(mount, gravity) {
  const phyZinc = new PhyZinc();
  phyZinc.pause(true);
  const renderer = new Zinc.Renderer(mount, window);
  Zinc.defaultMaterialColor = 0xFFFF9C;
  await phyZinc.attach(renderer);
  const scene = phyZinc.startNewScene("cloth");
  const clothOptions = ClothOptions(20, 20, 0.1, [0, 0, 0]);
  clothOptions.gravity = [0, 0, gravity];
  const cloth = new ClothPatch(renderer, clothOptions);
  await cloth.initialise();
  // +Y is the curtain's normal (it hangs in the XZ plane), blowing it away
  // from the camera, which sits on -Y.
  // Wind was tuned against full gravity (9.81), so scale it with gravity to
  // keep the same look at whatever gravity the UI passes in.
  cloth.setWind([0, 6 * Math.abs(gravity) / 9.81, 0], 0.8);
  phyZinc.addDeformable(cloth, "cloth");
  phyZinc.startSimulation();

  // The patch is Y-thin (a hanging curtain in the XZ plane), so point the
  // camera along Y explicitly rather than relying on viewAll()'s default
  // angle, which isn't guaranteed to face a flat patch head-on.
  const { gridWidth, gridHeight, spacing, origin } = clothOptions;
  const center = [
    origin[0] + (gridWidth - 1) * spacing / 2,
    origin[1],
    origin[2] - (gridHeight - 1) * spacing / 2,
  ];
  const distance = Math.max(gridWidth, gridHeight) * spacing * 1.5;
  scene.getZincCameraControls().setCurrentCameraSettings({
    eyePosition: [center[0], center[1] - distance, center[2]],
    targetPosition: center,
    upVector: [0, 0, 1],
  });

  return phyZinc;
}
