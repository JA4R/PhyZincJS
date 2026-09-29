import { PhysicsOptions, JointOptions } from "../../phyZinc.js"

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

export const loadDummyBody = (phyZinc) => {
  const gltfURL = `${import.meta.env.BASE_URL}dummy_body.glb`;
  const objectsByGroupName = new Map();
  phyZinc.addObjectAddedCallback(gltfObjectAdded(phyZinc, objectsByGroupName));
  phyZinc.addDownloadCompletedCallback(createRagdollJoints(phyZinc, objectsByGroupName));
  phyZinc.loadGLTF(gltfURL);
}


// Primitive scene-building helpers shared by the demos.
export const addSpheres = (phyZinc, radius, counts, area, position) => {
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

export const addBoxes = (phyZinc, dimension, counts, area, position) => {
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

