import Zinc from "zincjs";
import { PhyZinc } from "../../phyZinc.js"
import { ClothPatch, ClothOptions } from "../../physics/pbdCloth.js"

// A cloth pinned at its four corners like a trampoline, with bodies dropped
// onto it. Collision feedback (two-way coupling) is what lets the cloth catch
// them; without it they would punch straight through.
export async function startClothTrampolineScene(mount, gravity) {
  const phyZinc = new PhyZinc();
  await phyZinc.initialise();
  phyZinc.pause(true);
  const renderer = new Zinc.Renderer(mount, window);
  Zinc.defaultMaterialColor = 0xFFFF9C;
  await phyZinc.attach(renderer);
  const scene = phyZinc.startNewScene("cloth-trampoline");
  phyZinc.setGravity(gravity);

  const floorZ = -1.0;
  phyZinc.addFloor([0, 0, floorZ], [3, 3]);
  // Densities (kg/m³) give bodies of roughly 0.1-0.4 kg, comparable to the
  // ~0.58 kg cloth, so they visibly dent it without tearing through.
  phyZinc.addSphere([0.1, 0.05, 0.9], 0.15, 32, 32, 30);
  phyZinc.addSphere([-0.35, 0.3, 1.4], 0.1, 24, 24, 30);
  phyZinc.addBox([0.35, -0.3, 1.8], [0.2, 0.2, 0.2], 30);

  phyZinc.addSpotLight({
    position: [1.2, -1.5, 1.8],
    target: [0, 0, floorZ],
    intensity: 15,
    angle: Math.PI / 5,
    penumbra: 0.4,
    shadowMapSize: 2048,
    shadowNear: 0.5,
    shadowFar: 6,
  });
  scene.directionalLight.intensity = 0.3 * Math.PI;

  // Horizontal patch in the XY plane, pinned at its corners, above the floor.
  const gridSize = 24;
  const spacing = 0.075;
  const halfSpan = (gridSize - 1) * spacing / 2;
  const clothOptions = ClothOptions(gridSize, gridSize, spacing, [-halfSpan, halfSpan, 0]);
  clothOptions.pin = 'corners';
  clothOptions.rowDirection = [0, -1, 0];
  clothOptions.gravity = [0, 0, gravity];
  const cloth = new ClothPatch(renderer, clothOptions);
  await cloth.initialise();
  cloth.setCollisionFeedback(true);
  phyZinc.addDeformable(cloth, "cloth");
  phyZinc.startSimulation();

  scene.getZincCameraControls().setCurrentCameraSettings({
    eyePosition: [0, -3.2, 1.2],
    targetPosition: [0, 0, -0.1],
    upVector: [0, 0, 1],
  });

  return phyZinc;
}
