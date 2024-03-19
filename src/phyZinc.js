import { getRapier } from './physics/rapier';
import Zinc from "zincjs";
const THREE = Zinc.THREE;
//const RAPIER  = function() {
//    return this;
//}

const PhyZinc = function() {
    this.rapier = undefined;
    this.renderer = undefined;
    this.physicsWorld = undefined;
    let gravity = -9.81;
    const objects = [];

    this.setGravity = g => {
        gravity = g;
    }

    this.getPhysicsWorld = () => {
        if (!this.physicsWorld) {
            gravity = new THREE.Vector3(0.0, 0.0, gravity);
            this.physicsWorld = new this.rapier.World(gravity);
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
        scene.addZincObject(zincObject);
        return zincObject;
    }

    this.addSphere = (position, radius, widthSegments, heightSegments) => {
        if (this.rapier) {
            const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
            const material = new THREE.MeshPhongMaterial({
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
                this.addPhysics(zincObject, true, true, false, collider, rigidBody);
            }
            return zincObject;
        } else {
            console.error("Physics engine is not ready yet.");
        }
    }

    this.addBox = (position, dimension) => {
        if (this.rapier) {
            const geometry = new THREE.BoxGeometry(...dimension);
            const material = new THREE.MeshPhongMaterial({
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
                this.addPhysics(zincObject, true, true, false, collider, rigidBody);
            }
            return zincObject;
        } else {
            console.error("Physics engine is not ready yet.");
        }
    }

    this.addFloor = (position, dimension) => {
        if (this.rapier) {
            const geometry = new THREE.PlaneGeometry(dimension[0], dimension[1]);
            const material = new THREE.MeshPhongMaterial({
                color: new THREE.Color("rgb(124, 252, 0)")
            });
            geometry.translate(position[0], position[1], position[2]);
            const zincObject = this.addGeometry(geometry, material, "floor");
            this.addPhysics(zincObject, false, false, false, undefined, undefined);
            return zincObject;
        } else {
            console.error("Physics engine is not ready yet.");
        }
    } 

    this.addPhysics = (zincObject, dynamic, translation, rotation,
        colliderIn, rigidBodyIn) => {
        if (this.rapier) {
            if (zincObject && zincObject.isGeometry) {
                const morph = zincObject.getMorph();
                const geometry = morph.geometry;
                const vertices = geometry.attributes.position.array;
                const indices = geometry.index.array;
                try {
                    const world = this.getPhysicsWorld();
                    let collider = colliderIn ? 
                        colliderIn : this.rapier.ColliderDesc.trimesh(vertices, indices);
                    zincObject.collider = collider;
                    let rigidBody = rigidBodyIn;
                    if (dynamic) {
                        zincObject.getMorph().matrixAutoUpdate = true;
                        zincObject.rigidBody = rigidBody ? 
                            rigidBody : world.createRigidBody(
                                this.rapier.RigidBodyDesc.dynamic());
                    } else {
                        zincObject.rigidBody = rigidBody?
                            rigidBody: world.createRigidBody(
                                this.rapier.RigidBodyDesc.fixed());
                    }
                    zincObject.worldCollider = world.createCollider(
                        zincObject.collider, zincObject.rigidBody);
                    zincObject.physicsT = translation;
                    zincObject.physicsR = rotation;
                    objects.push(zincObject);
                }
                catch {
                    console.error("unable to add physics to zincObject");
                }
            }
        }
    }
    
    const objectAddedCallback = () => {
        return (zincObject) => {
            console.log(zincObject.getBoundingBox())
            this.addPhysics(zincObject, true, true, true, undefined, undefined);
        }
    }
      
    const downloadCompletedCallback = () => {
        return () => {
            this.renderer.addPreRenderCallbackFunction(updatePhysicalWorld());
            this.renderer.playAnimation = true;
            this.renderer.animate();
        }
    }

    const updatePhysicalWorld = () => {
        return () => {
            if (this.physicsWorld) {
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

    this.startNewScene = sceneName => {
        if (this.renderer) {
            const scene = this.renderer.createScene(sceneName);
            this.renderer.setCurrentScene(scene);
        }
    }
      
    this.importZincMetadata = (url) => {
        if (this.isReady()) {
            if (this.renderer) {
                const scene = this.renderer.getCurrentScene();
                scene.loadMetadataURL(url, objectAddedCallback(),
                    downloadCompletedCallback());
            }
        } else {
            console.error("Physics engine is not ready yet.")
        }
    }

    this.attach = (renderer) => {
        this.renderer = renderer;
        this.renderer.initialiseVisualisation();
        this.renderer.playAnimation = false;
    }

    this.isReady = () => {
        return this.rapier !== undefined;
    }
}


export { PhyZinc };
