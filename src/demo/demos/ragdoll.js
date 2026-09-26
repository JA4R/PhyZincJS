import Zinc from "zincjs";
import { PhyZinc, PhysicsOptions, JointOptions } from "../../phyZinc.js"
import { addSpheres, addBoxes } from "./sceneHelpers.js"

// Rigid-body ragdoll: the dummy_body.glb parts get convex-hull colliders and
// are connected with the joints below, dropped into a walled box with spheres
// and boxes.
const ENABLED_GROUPS = [
  'Left_Shin',
  'Right_Shin',
  'Left_Arm',
  'Left_Forearm',
  'Left_Palm',
  'Pelvis',
  'Right_fingers',
  'Left_Fingers',
  'Right_Foot',
  'Left_Thigh',
  'Head',
  'Right_Thigh',
  'Right_Palm',
  'Right_Forearm',
  'Torso',
  'Left_Foot',
  'Right_Shoulder'
]

// Right_Shoulder is not a distinct shoulder segment - it's the right upper-arm mesh,
// mirroring Left_Arm, so Torso is the attachment point for both.
// Knee/elbow axis and limits are starting points - verify visually and adjust.
const JOINT_DEFS = [
  { parent: 'Torso', child: 'Pelvis', type: 'spherical' },
  { parent: 'Torso', child: 'Head', type: 'spherical' },
  { parent: 'Torso', child: 'Left_Arm', type: 'spherical' },
  { parent: 'Torso', child: 'Right_Shoulder', type: 'spherical' },
  { parent: 'Pelvis', child: 'Left_Thigh', type: 'spherical' },
  { parent: 'Pelvis', child: 'Right_Thigh', type: 'spherical' },
  { parent: 'Left_Thigh', child: 'Left_Shin', type: 'revolute', axis: [1, 0, 0], limits: [0, 2.3] },
  { parent: 'Right_Thigh', child: 'Right_Shin', type: 'revolute', axis: [1, 0, 0], limits: [0, 2.3] },
  { parent: 'Left_Shin', child: 'Left_Foot', type: 'spherical' },
  { parent: 'Right_Shin', child: 'Right_Foot', type: 'spherical' },
  { parent: 'Left_Arm', child: 'Left_Forearm', type: 'revolute', axis: [1, 0, 0], limits: [0, 2.3] },
  { parent: 'Right_Shoulder', child: 'Right_Forearm', type: 'revolute', axis: [1, 0, 0], limits: [0, 2.3] },
  { parent: 'Left_Forearm', child: 'Left_Palm', type: 'spherical' },
  { parent: 'Right_Forearm', child: 'Right_Palm', type: 'spherical' },
  { parent: 'Left_Palm', child: 'Left_Fingers', type: 'spherical' },
  { parent: 'Right_Palm', child: 'Right_fingers', type: 'spherical' },
]

const gltfObjectAdded = (phyZinc, objectsByGroupName) => {
  return function(zincObject) {
    const morph = zincObject.getMorph();
    console.log(zincObject.groupName)
    const scale = morph.scale;
    const geometry = morph.geometry;
    geometry.scale(scale.x, scale.y, scale.z)
    scale.set(1, 1, 1);
    morph.quaternion.set(0, 0, 0, 1);
    geometry.rotateX( Math.PI / 2);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    objectsByGroupName.set(zincObject.groupName, zincObject);
    if (ENABLED_GROUPS.includes(zincObject.groupName)) {
      phyZinc.addPhysicsToObject(zincObject,
        PhysicsOptions(true, true, true, undefined, undefined, 0.1, 0.01));
    }
  }
}

const createRagdollJoints = (phyZinc, objectsByGroupName) => {
  return function() {
    JOINT_DEFS.forEach(def => {
      const parentObject = objectsByGroupName.get(def.parent);
      const childObject = objectsByGroupName.get(def.child);
      if (parentObject && childObject) {
        phyZinc.addJoint(parentObject, childObject,
          JointOptions(def.type, def.axis, def.limits));
      }
    })
  }
}

const loadGLTF = (phyZinc) => {
  const dimension = [2.5, 2.5];
  const position = [0, 0, -1.5];
  phyZinc.addFloor(position, dimension);
  phyZinc.addWalls(position, dimension, /*wallHeight*/1.5);
  addSpheres(phyZinc, /*radius*/0.03, [5, 5], [1.25, 1.25], position);
  addBoxes(phyZinc, [0.06, 0.06, 0.06], [5, 5], [1.25, 1.25], [0, 0, 1.0]);
  const gltfURL = `${import.meta.env.BASE_URL}dummy_body.glb`;
  const objectsByGroupName = new Map();
  phyZinc.addObjectAddedCallback(gltfObjectAdded(phyZinc, objectsByGroupName));
  phyZinc.addDownloadCompletedCallback(createRagdollJoints(phyZinc, objectsByGroupName));
  phyZinc.loadGLTF(gltfURL);
}

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
  loadGLTF(phyZinc);
  return phyZinc;
}
