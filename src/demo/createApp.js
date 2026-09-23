import Zinc from "zincjs";
import { PhyZinc, PhysicsOptions, JointOptions } from "../phyZinc.js"
import { createClothPatch, ClothOptions } from "../physics/pbdCloth.js"

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


const addSpheres = (phyZinc, radius, counts, area, position) => {
  const offset = [
    position[0] - area[0] / 2.0,
    position[1] - area[1] / 2.0,
  ]
  const increment = [
    area[0] / (counts[0] + 1),
    area[1] / (counts[1] + 1),
  ];
  for (let i = 0;  i < counts[0]; i++) {
    const x = offset[0] + increment[0] * ( i + 1 );
    for (let j = 0; j < counts[1]; j++) {
      const y = offset[1] + increment[1] * ( j + 1 );
      phyZinc.addSphere([x, y, position[2] + radius], radius, 16, 16);
    }
  }
}

const addBoxes = (phyZinc, dimension, counts, area, position) => {
  const offset = [
    position[0] - area[0] / 2.0,
    position[1] - area[1] / 2.0,
  ]
  const increment = [
    area[0] / (counts[0] + 1),
    area[1] / (counts[1] + 1),
  ];
  for (let i = 0;  i < counts[0]; i++) {
    const x = offset[0] + increment[0] * ( i + 1 );
    for (let j = 0; j < counts[1]; j++) {
      const y = offset[1] + increment[1] * ( j + 1 );
      phyZinc.addBox([x, y, position[2]], dimension);
    }
  }
}

const addWalls = (phyZinc, floorPosition, floorDimension, wallHeight) => {
  const halfX = floorDimension[0] / 2;
  const halfY = floorDimension[1] / 2;
  const wallZ = floorPosition[2] + wallHeight / 2;

  // North/South walls: perpendicular to Y, spanning the floor's X edge
  phyZinc.addFloor([floorPosition[0], floorPosition[1] + halfY, wallZ],
    [floorDimension[0], wallHeight], [Math.PI / 2, 0, 0]);
  phyZinc.addFloor([floorPosition[0], floorPosition[1] - halfY, wallZ],
    [floorDimension[0], wallHeight], [Math.PI / 2, 0, 0]);

  // East/West walls: perpendicular to X, spanning the floor's Y edge
  phyZinc.addFloor([floorPosition[0] + halfX, floorPosition[1], wallZ],
    [wallHeight, floorDimension[1]], [0, Math.PI / 2, 0]);
  phyZinc.addFloor([floorPosition[0] - halfX, floorPosition[1], wallZ],
    [wallHeight, floorDimension[1]], [0, Math.PI / 2, 0]);
}

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
  phyZinc.addFloor(position, /*dimenstion*/dimension);
  addWalls(phyZinc, position, dimension, /*wallHeight*/1.5);
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
  phyZinc.addFloor(position, /*dimenstion*/dimension);
  addSpheres(phyZinc, /*radius*/30, [5, 5], [500, 500], position);
  addBoxes(phyZinc, [60, 60, 60], [5, 5], [450, 450], [0, 0, -250]);
  const metaURL = `${import.meta.env.BASE_URL}body_metadata.json`
  phyZinc.importZincMetadata(metaURL);
} 

// WebGPU PBD cloth-patch proof of concept — self-contained, no Rapier/physics
// dependency. Never calls phyZinc.initialise() (which loads the Rapier WASM
// module), only PhyZinc's generic rendering setup (attach/startNewScene/addMesh).
export async function startClothScene(mount) {
  const phyZinc = new PhyZinc();
  const renderer = new Zinc.Renderer(mount, window);
  Zinc.defaultMaterialColor = 0xFFFF9C;
  await phyZinc.attach(renderer);
  const scene = phyZinc.startNewScene("cloth");
  const clothOptions = ClothOptions(20, 20, 0.1, [0, 0, 0]);
  const cloth = await createClothPatch(renderer, clothOptions);
  // +Y is the curtain's normal (it hangs in the XZ plane), blowing it away
  // from the camera, which sits on -Y.
  cloth.setWind([0, 6, 0], 0.8);
  phyZinc.addMesh(cloth.mesh, "cloth");
  renderer.addPreRenderCallbackFunction(cloth.step);
  renderer.playAnimation = true;
  renderer.animate();

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

  return { phyZinc, cloth };
}

export async function startScene(mount, gravity) {
  const phyZinc = new PhyZinc();
  await phyZinc.initialise();
  phyZinc.pause(true);
  console.log("Initialised rapier")
  const renderer = new Zinc.Renderer(mount, window);
  Zinc.defaultMaterialColor = 0xFFFF9C;
  await phyZinc.attach(renderer);
  phyZinc.startNewScene("test");
  phyZinc.setGravity(gravity);
  loadGLTF(phyZinc);
  return phyZinc;
}
