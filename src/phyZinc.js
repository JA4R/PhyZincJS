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

    this.initialise = async () => {
        if (!this.rapier) {
            this.rapier = await getRapier();
        }
        return this.rapier;
    }

    this.addPhysics = (zincObject) => {
        if (this.rapier) {
            if (zincObject && zincObject.isGeometry) {
                const morph = zincObject.getMorph();
                const geometry = morph.geometry;
                const vertices = geometry.attributes.position.array;
                const indices = geometry.index.array;
                try {
                    let collider = this.rapier.ColliderDesc.trimesh(
                        vertices, indices);
                    zincObject.getMorph().matrixAutoUpdate = true;
                    zincObject.collider = collider;
                    zincObject.rigidBody = this.physicsWorld.createRigidBody(
                        this.rapier.RigidBodyDesc.dynamic());
                    zincObject.worldCollider = this.physicsWorld.createCollider(
                        collider, zincObject.rigidBody);
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
            this.addPhysics(zincObject);
        }
    }
      
    const downloadCompletedCallback = () => {
        return () => {
            this.renderer.playAnimation = true;
            this.renderer.animate();
        }
    }

    const updatePhysicalWorld = () => {
        return () => {
            this.physicsWorld?.step();
            objects.forEach(target => {
                if (target.isZincObject) {
                    const t = target.rigidBody.translation();
                    const morph = target.getMorph()
                    morph.position.set(t.x, t.y, t.z);
                }
            });
        }
    }
      
    this.importZincMetadata = (sceneName, url) => {
        if (this.isReady()) {
            if (this.renderer) {
                if (!this.physicalWorld) {
                    gravity = new THREE.Vector3(0.0, 0.0, gravity);
                    this.physicsWorld = new this.rapier.World(gravity);
                }
                const scene = this.renderer.createScene(sceneName);
                this.renderer.setCurrentScene(scene);
                scene.loadMetadataURL(url, objectAddedCallback(),
                    downloadCompletedCallback());
                this.renderer.addPreRenderCallbackFunction(updatePhysicalWorld());
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
