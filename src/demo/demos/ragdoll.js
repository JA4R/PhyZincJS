import Zinc from "zincjs";
import { PhyZinc } from "../../phyZinc.js"
import { addSpheres, addBoxes, loadDummyBody } from "./sceneHelpers.js"


const loadMetadata = (phyZinc) => {
  const dimension = [2000, 2000];
  const position = [0, 0, -500];
  phyZinc.addFloor(position, dimension);
  addSpheres(phyZinc, /*radius*/30, [5, 5], [500, 500], position);
  addBoxes(phyZinc, [60, 60, 60], [5, 5], [450, 450], [0, 0, -250]);
  const metaURL = `${import.meta.env.BASE_URL}body_metadata.json`
  phyZinc.importZincMetadata(metaURL);
}

export async function startRagdollScene(mount, gravity) {
  const phyZinc = new PhyZinc();
  await phyZinc.initialise();
  phyZinc.pause(true);
  console.log("Initialised rapier")
  const renderer = new Zinc.Renderer(mount, window);
  Zinc.defaultMaterialColor = 0xFFFF9C;
  await phyZinc.attach(renderer);
  const scene = phyZinc.startNewScene("ragdoll");
  phyZinc.addSpotLight({
    position: [0.0, 0.0, 3.0],
    target: [0, 0, 0],
    intensity: 15,
    angle: Math.PI / 5,
    penumbra: 0.4,
    shadowMapSize: 2048,
    shadowNear: 0.5,
    shadowFar: 6,
  });
  scene.directionalLight.intensity = 0.3 * Math.PI;
  phyZinc.setGravity(gravity);
  const dimension = [2.5, 2.5];
  const position = [0, 0, -1.5];
  phyZinc.addFloor(position, dimension);
  phyZinc.addWalls(position, dimension, /*wallHeight*/1.5);
  addSpheres(phyZinc, /*radius*/0.03, [5, 5], [1.25, 1.25], position);
  addBoxes(phyZinc, [0.06, 0.06, 0.06], [5, 5], [1.25, 1.25], [0, 0, 1.0]);
  loadDummyBody(phyZinc);
  return phyZinc;
}
