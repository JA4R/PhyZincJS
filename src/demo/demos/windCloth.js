import Zinc from "zincjs";
import { PhyZinc } from "../../phyZinc.js"
import { ClothPatch, ClothOptions } from "../../physics/pbdCloth.js"

// Balls shot with Space: launched from the camera eye toward the mouse.
const BALL_RADIUS = 0.1;
const BALL_SPEED = 5;
// ~0.4 kg, about the cloth's weight (400 particles × 1 g), so it billows.
const BALL_DENSITY = 100;
// There's no floor, so balls fall forever; the oldest are removed past this
// many, also keeping the cloth under its 64-collider limit.
const MAX_BALLS = 20;

// WebGPU XPBD cloth curtain pinned at its top corners, blown by gusty wind.
// Press Space to shoot a ball from the camera toward the mouse pointer.
export async function startWindClothScene(mount, gravity, events) {
  const phyZinc = new PhyZinc();
  // Rapier is only needed for the shot balls.
  await phyZinc.initialise();
  phyZinc.pause(true);
  const renderer = new Zinc.Renderer(mount, window);
  Zinc.defaultMaterialColor = 0xFFFF9C;
  await phyZinc.attach(renderer);
  const scene = phyZinc.startNewScene("cloth");
  phyZinc.setGravity(gravity);
  const clothOptions = ClothOptions(20, 20, 0.1, [0, 0, 0]);
  clothOptions.gravity = [0, 0, gravity];
  const cloth = new ClothPatch(renderer, clothOptions);
  await cloth.initialise();
  // +Y is the curtain's normal (it hangs in the XZ plane), blowing it away
  // from the camera, which sits on -Y.
  // Wind was tuned against full gravity (9.81), so scale it with gravity to
  // keep the same look at whatever gravity the UI passes in.
  cloth.setWind([0, 6 * Math.abs(gravity) / 9.81, 0], 0.8);
  // Two-way coupling, so the cloth slows the balls rather than letting them
  // pass straight through.
  cloth.setCollisionFeedback(true);
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

  const balls = [];
  phyZinc.addKeyDownCallback((event) => {
    if (event.code !== 'Space' || event.repeat || phyZinc.isPaused()) return;
    event.preventDefault(); // stop Space scrolling the page
    const ball = phyZinc.shootSphere(BALL_RADIUS, BALL_SPEED, BALL_DENSITY);
    if (!ball) return;
    balls.push(ball);
    if (balls.length > MAX_BALLS) phyZinc.removeObject(balls.shift());
    events?.dismissHint();
  });

  return phyZinc;
}

// Switches the wind on every cloth in a scene started by startWindClothScene.
export function setWindEnabled(phyZinc, enabled) {
  phyZinc.getDeformables().forEach(deformable => deformable.setWindEnabled?.(enabled));
}
