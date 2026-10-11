import Zinc from 'zincjs';
import { PhyZinc } from '../../phyZinc.js';
import { ClothPatch, ClothOptions } from '../../physics/pbdCloth.js';

// A cloth dropped over resting rigid bodies, with a ball falling onto it.
// Coupling is two-way: the cloth also pushes back on the bodies it touches.
// Drag the bodies to push them around under the cloth, or drag the cloth to
// pull at them.
export async function startClothCollisionScene(mount, gravity) {
  const phyZinc = new PhyZinc();
  await phyZinc.initialise();
  phyZinc.pause(true);
  const renderer = new Zinc.Renderer(mount, window);
  Zinc.defaultMaterialColor = 0xffff9c;
  await phyZinc.attach(renderer);
  const scene = phyZinc.startNewScene('cloth-collision');
  phyZinc.setGravity(gravity);

  const floorZ = -1.0;
  phyZinc.addFloor([0, 0, floorZ], [3, 3]);
  // Densities (kg/m³) chosen so the bodies outweigh the ~0.58 kg cloth.
  phyZinc.addSphere([0.25, 0.1, floorZ + 0.3], 0.3, 32, 32, 50);
  phyZinc.addBox([-0.45, -0.25, floorZ + 0.2], [0.4, 0.4, 0.4], 50);
  phyZinc.addSphere([0.5, -0.45, 0.8], 0.12, 24, 24, 50);

  // Spotlight above and in front of the bodies, so the cloth and bodies cast
  // shadows onto the floor and each other. Dim Zinc's camera-following
  // directional light so it doesn't wash those shadows out.
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

  // Horizontal patch in the XY plane, above the bodies, pinned nowhere so it
  // falls and drapes over them.
  const gridSize = 24;
  const spacing = 0.075;
  const halfSpan = ((gridSize - 1) * spacing) / 2;
  const clothOptions = ClothOptions(gridSize, gridSize, spacing, [-halfSpan, halfSpan, 0]);
  clothOptions.pin = 'none';
  clothOptions.rowDirection = [0, -1, 0];
  clothOptions.gravity = [0, 0, gravity];
  const cloth = new ClothPatch(renderer, clothOptions);
  await cloth.initialise();
  // Two-way coupling: the cloth's weight and friction push back on the bodies.
  cloth.setCollisionFeedback(true);
  phyZinc.addDeformable(cloth, 'cloth');
  phyZinc.startSimulation();

  scene.getZincCameraControls().setCurrentCameraSettings({
    eyePosition: [0, -3.2, 1.0],
    targetPosition: [0, 0, floorZ + 0.3],
    upVector: [0, 0, 1],
  });

  return phyZinc;
}
