import { getRapier } from './physics/rapier';
import Zinc from "zincjs";
const THREE = Zinc.THREE;
//const RAPIER  = function() {
//    return this;
//}

const PhysicsOptions = function( dynamic, translation, rotation,
    collider, rigidBody, softCcdPrediction, contactSkin) {
    return {
        dynamic,
        translation,
        rotation,
        collider,
        rigidBody,
        softCcdPrediction,
        contactSkin
    };
}

const JointOptions = function( type, axis, limits, anchor, contactsEnabled) {
    return {
        type,
        axis,
        limits,
        anchor,
        contactsEnabled
    };
}

const PhyZinc = function() {
    this.rapier = undefined;
    this.renderer = undefined;
    this.physicsWorld = undefined;
    let gravity = -9.81;
    const objects = [];
    const joints = [];
    const addedObjectCallbacks = [];
    const downloadCompletedCallbacks = [];
    let paused = false;

    this.setGravity = g => {
        gravity = g;
    }

    this.getPhysicsWorld = () => {
        if (!this.physicsWorld) {
            let gravityIn = new THREE.Vector3(0.0, 0.0, gravity);
            this.physicsWorld = new this.rapier.World(gravityIn);
        }
        return this.physicsWorld;
    }

    this.initialise = async () => {
        if (!this.rapier) {
            this.rapier = await getRapier();
        }
        return this.rapier;
    }

    this.addGeometry = (geometry, material, name) => {
        const scene = this.renderer.getCurrentScene();
        const zincObject = new Zinc.Geometry();
        zincObject.setName(name);
        zincObject.createMesh(
            geometry,
            material,
            {
                opacity: 1.0,
                localTimeEnabled: false,
                localMorphColour: false

            }
        );
        zincObject.isPhyZincsObject = true;
        scene.addZincObject(zincObject);
        return zincObject;
    }

    this.addSphere = (position, radius, widthSegments, heightSegments) => {
        if (this.rapier) {
            const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
            const material = new THREE.MeshPhongNodeMaterial({
                color: new THREE.Color("rgb(255, 215, 0)")
            });
            //geometry.translate(position[0], position[1], position[2]);
            const zincObject = this.addGeometry(geometry, material, "balls");
            if (zincObject) {
                const world = this.getPhysicsWorld();
                const rbDesc = this.rapier.RigidBodyDesc.dynamic()
                    .setTranslation(position[0], position[1], position[2])
                    .setLinearDamping(0.1);
                const rigidBody = world.createRigidBody(rbDesc);
                const collider = this.rapier.ColliderDesc.ball(radius)
                    .setFriction(0.1)
                    .setFrictionCombineRule(this.rapier.CoefficientCombineRule.Max)
                    // .setTranslation(0, 0, 0)
                    .setRestitution(0.6)
                    .setRestitutionCombineRule(this.rapier.CoefficientCombineRule.Max);
                const options = PhysicsOptions(true, true, false, collider, rigidBody, 0.0, 0.0);
                this.addPhysicsToObject(zincObject, options);
            }
            return zincObject;
        } else {
            console.error("Physics engine is not ready yet.");
        }
    }

    this.addBox = (position, dimension) => {
        if (this.rapier) {
            const geometry = new THREE.BoxGeometry(...dimension);
            const material = new THREE.MeshPhongNodeMaterial({
                color: new THREE.Color("rgb(0, 0, 200)")
            });
            //geometry.translate(position[0], position[1], position[2]);
            const zincObject = this.addGeometry(geometry, material, "box");
            if (zincObject) {
                const world = this.getPhysicsWorld();
                const rbDesc = this.rapier.RigidBodyDesc.dynamic()
                    .setTranslation(position[0], position[1], position[2])
                    .setLinearDamping(0.1);
                const rigidBody = world.createRigidBody(rbDesc);
                const collider = this.rapier.ColliderDesc
                    .cuboid(dimension[0] / 2, dimension[1] / 2, dimension[2] / 2)
                    .setFriction(0.1)
                    .setFrictionCombineRule(this.rapier.CoefficientCombineRule.Max)
                    .setRestitution(0.2)
                    .setRestitutionCombineRule(this.rapier.CoefficientCombineRule.Max);
                const options = PhysicsOptions(true, true, false, collider, rigidBody, 0.0, 0.0);
                this.addPhysicsToObject(zincObject, options);
            }
            return zincObject;
        } else {
            console.error("Physics engine is not ready yet.");
        }
    }

    this.addFloor = (position, dimension, rotation) => {
        if (this.rapier) {
            const geometry = new THREE.PlaneGeometry(dimension[0], dimension[1]);
            const material = new THREE.MeshPhongNodeMaterial({
                color: new THREE.Color("rgb(124, 252, 0)"),
                opacity: 0.5,
                transparent: true,

            });
            if (rotation) {
                geometry.rotateX(rotation[0]);
                geometry.rotateY(rotation[1]);
                geometry.rotateZ(rotation[2]);
            }
            geometry.translate(position[0], position[1], position[2]);
            const zincObject = this.addGeometry(geometry, material, "floor");
            const options = PhysicsOptions(false, false, false, undefined, undefined, 1.0, 0.0);
            this.addPhysicsToObject(zincObject, options);
            return zincObject;
        } else {
            console.error("Physics engine is not ready yet.");
        }
    } 

    const createDynamicCollider = (vertices, indices) => {
        let collider = this.rapier.ColliderDesc.convexHull(vertices);
        if (!collider) {
            console.warn("convexHull failed (degenerate geometry), falling back to trimesh collider");
            collider = this.rapier.ColliderDesc.trimesh(vertices, indices);
        }
        return collider;
    }

    const computeJointAnchor = (objectA, objectB) => {
        const boxOf = (zincObject) => {
            const geometry = zincObject.getMorph().geometry;
            if (!geometry.boundingBox) {
                geometry.computeBoundingBox();
            }
            return geometry.boundingBox;
        }
        const boxA = boxOf(objectA);
        const boxB = boxOf(objectB);
        const overlap = boxA.clone().intersect(boxB);
        if (!overlap.isEmpty()) {
            return overlap.getCenter(new THREE.Vector3());
        }
        const centerA = boxA.getCenter(new THREE.Vector3());
        const centerB = boxB.getCenter(new THREE.Vector3());
        return centerA.add(centerB).multiplyScalar(0.5);
    }

    this.addPhysicsToObject = (zincObject, options) => {
        if (this.rapier) {
            if (zincObject && zincObject.isGeometry) {
                const morph = zincObject.getMorph();
                const geometry = morph.geometry;
                const vertices = geometry.attributes.position.array;
                const indices = geometry.index.array;
                try {
                    const world = this.getPhysicsWorld();
                    let collider = options.collider ? options.collider
                        : options.dynamic ? createDynamicCollider(vertices, indices)
                        : this.rapier.ColliderDesc.trimesh(vertices, indices);
                    collider.setContactSkin(options.contactSkin);
                    zincObject.collider = collider;
                    let rigidBody = options.rigidBody;
                    if (options.dynamic) {
                        zincObject.getMorph().matrixAutoUpdate = true;
                        zincObject.rigidBody = rigidBody ? 
                            rigidBody : world.createRigidBody(
                                this.rapier.RigidBodyDesc.dynamic());
                    } else {
                        zincObject.rigidBody = rigidBody ?
                            rigidBody: world.createRigidBody(
                                this.rapier.RigidBodyDesc.fixed());
                    }
                    zincObject.rigidBody.setSoftCcdPrediction(
                        options.softCcdPrediction);
                    zincObject.worldCollider = world.createCollider(
                        zincObject.collider, zincObject.rigidBody);
                    zincObject.physicsT = options.translation;
                    zincObject.physicsR = options.rotation;
                    objects.push(zincObject);
                }
                catch {
                    console.error("unable to add physics to zincObject");
                }
            }
        }
    }

    this.addJoint = (objectA, objectB, options) => {
        if (this.rapier && objectA && objectB && objectA.rigidBody && objectB.rigidBody) {
            const world = this.getPhysicsWorld();
            const anchor = options.anchor ? options.anchor : computeJointAnchor(objectA, objectB);
            const jointData = options.type === "revolute" ?
                this.rapier.JointData.revolute(anchor, anchor,
                    new THREE.Vector3(options.axis[0], options.axis[1], options.axis[2])) :
                this.rapier.JointData.spherical(anchor, anchor);
            const joint = world.createImpulseJoint(
                jointData, objectA.rigidBody, objectB.rigidBody, true);
            if (options.type === "revolute" && options.limits) {
                joint.setLimits(options.limits[0], options.limits[1]);
            }
            joint.setContactsEnabled(
                options.contactsEnabled === undefined ? false : options.contactsEnabled);
            joints.push(joint);
            return joint;
        } else {
            console.error("unable to add joint between zincObjects");
        }
    }

    const objectAddedCallback = () => {
        return (zincObject) => {
            if (!zincObject.isPhyZincsObject) {
                addedObjectCallbacks.forEach(callback => {
                    callback(zincObject);
                })
            }
        }
    }

    this.addObjectAddedCallback = (callback) => {
        if (callback && (typeof callback === "function")) {
            addedObjectCallbacks.push(callback);
        }
    }

    this.addDownloadCompletedCallback = (callback) => {
        if (callback && (typeof callback === "function")) {
            downloadCompletedCallbacks.push(callback);
        }
    }

    const downloadCompletedCallback = () => {
        return () => {
            downloadCompletedCallbacks.forEach(callback => {
                callback();
            })
            this.renderer.addPreRenderCallbackFunction(updatePhysicalWorld());
            this.renderer.playAnimation = true;
            this.renderer.animate();
            const scene = this.renderer.getCurrentScene();
            console.log(scene.getBoundingBox());
            scene.viewAll();
        }
    }

    const updatePhysicalWorld = () => {
        return () => {
            if (this.physicsWorld && !paused) {
                this.physicsWorld.step();
                objects.forEach(target => {
                    if (target.isZincObject) {
                        const morph = target.getMorph();
                        if (target.physicsT) {
                            const t = target.rigidBody.translation();
                            morph.position.set(t.x, t.y, t.z);
                        }
                        if (target.physicsR) {
                            const r = target.rigidBody.rotation();
                            morph.quaternion.set(r.x, r.y, r.z, r.w);
                        }
                    }
                });
            }
        }
    }

    this.pause = (flag) => {
        paused = flag;
    }

    this.isPaused = () => {
        return paused;
    }

    this.startNewScene = sceneName => {
        if (this.renderer) {
            const scene = this.renderer.createScene(sceneName);
            scene.addZincObjectAddedCallbacks(objectAddedCallback());
            this.renderer.setCurrentScene(scene);
        }
    }

    this.importZincMetadata = (url) => {
        if (this.isReady()) {
            if (this.renderer) {
                const scene = this.renderer.getCurrentScene();
                scene.loadMetadataURL(url, undefined,
                    downloadCompletedCallback());
            }
        } else {
            console.error("Physics engine is not ready yet.")
        }
    }

    this.loadGLTF = (url) => {
        if (this.isReady()) {
            if (this.renderer) {
                const scene = this.renderer.getCurrentScene();
                scene.loadGLTF(url, undefined, downloadCompletedCallback());
            }
        } else {
            console.error("Physics engine is not ready yet.")
        }
    }

    this.attach = async (renderer) => {
        this.renderer = renderer;
        await this.renderer.initialiseVisualisation();
        this.renderer.playAnimation = false;
    }

    this.isReady = () => {
        return this.rapier !== undefined;
    }

    this.dispose = () => {
        this.zincObjects.forEach(object => {
            delete zincObject.worldCollider;
        });
        if (this.physicsWorld) {
            delete this.physicsWorld;
            this.physicsWorld = undefined;
        }
        if (this.renderer) {
            this.renderer.dispose();
        }
    }
}

export { PhyZinc, PhysicsOptions, JointOptions };
