import { getRapier } from './physics/rapier';
import Zinc from "zincjs";
import { Deformable } from './physics/deformable.js';
const THREE = Zinc.THREE;


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

// Floors/walls use trimesh colliders, which deformables can't collide against,
// so each also records this thin analytic box proxy (see getColliderShapes).
const FLOOR_PROXY_HALF_THICKNESS = 0.02;

const PhyZinc = function() {
    this.rapier = undefined;
    this.renderer = undefined;
    this.physicsWorld = undefined;
    let gravity = -9.81;
    const objects = [];
    const joints = [];
    // Deformable instances (e.g. ClothPatch) stepped alongside Rapier; see
    // physics/deformable.js for the interface PhyZinc relies on.
    const deformables = [];
    // Lights added by addSpotLight(), removed again by dispose().
    const lights = [];
    let simulationStarted = false;
    const addedObjectCallbacks = [];
    const downloadCompletedCallbacks = [];
    let paused = false;
    let dragState = null;
    let dragListenersAttached = false;

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

    // Shadows only show once a shadow-casting light exists (see addSpotLight).
    // Traverses the morph because Zinc renders a transparent mesh (e.g. the
    // floor) as the morph drawing back faces plus a child mesh drawing front
    // faces, and the child needs the flags too.
    const setShadows = (zincObject, cast, receive) => {
        zincObject.getMorph()?.traverse(child => {
            if (child.isMesh) {
                child.castShadow = cast;
                child.receiveShadow = receive;
            }
        });
    }

    // Adds a shadow-casting THREE.SpotLight to the current scene and turns on
    // the renderer's shadow maps. Call before startSimulation(): materials
    // compiled before shadows are enabled won't pick them up. Positions are in
    // world space; shadowNear/shadowFar bound the light's shadow camera, so keep
    // them tight around the scene to avoid acne. Returns the light.
    this.addSpotLight = (options) => {
        if (!this.renderer) {
            console.error("addSpotLight needs attach() to have been called first.");
            return;
        }
        const {
            position = [0, 0, 3], target = [0, 0, 0], color = 0xffffff, intensity = 5,
            angle = Math.PI / 6, penumbra = 0.3, distance = 0, decay = 2,
            castShadow = true, shadowMapSize = 1024, shadowNear = 0.1, shadowFar = 10,
            shadowBias = -0.0005
        } = options ?? {};
        const shadowMap = this.renderer.getThreeJSRenderer().shadowMap;
        shadowMap.enabled = true;
        shadowMap.type = THREE.PCFSoftShadowMap;

        const light = new THREE.SpotLight(color, intensity, distance, angle, penumbra, decay);
        light.position.set(...position);
        light.target.position.set(...target);
        light.castShadow = castShadow;
        light.shadow.mapSize.set(shadowMapSize, shadowMapSize);
        light.shadow.camera.near = shadowNear;
        light.shadow.camera.far = shadowFar;
        light.shadow.bias = shadowBias;
        // The target must be in the scene so its world matrix stays up to date;
        // otherwise the light keeps pointing at the origin.
        const scene = this.renderer.getCurrentScene();
        scene.addObject(light);
        scene.addObject(light.target);
        lights.push({ light, scene });
        return light;
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
        setShadows(zincObject, true, true);
        scene.addZincObject(zincObject);
        return zincObject;
    }

    this.addMesh = (mesh, name) => {
        const scene = this.renderer.getCurrentScene();
        const zincObject = new Zinc.Geometry();
        zincObject.setName(name);
        zincObject.setMesh(mesh, false, false);
        zincObject.isPhyZincsObject = true;
        setShadows(zincObject, true, true);
        scene.addZincObject(zincObject);
        return zincObject;
    }

    // Adds a deformable (GPU-simulated) object's mesh to the scene and steps it
    // after each Rapier step, feeding it the current rigid colliders first.
    this.addDeformable = (deformable, name) => {
        if (!(deformable instanceof Deformable)) {
            console.error("addDeformable expects a Deformable (see physics/deformable.js)");
            return;
        }
        const zincObject = this.addMesh(deformable.mesh, name);
        deformables.push(deformable);
        return zincObject;
    }

    // World-space analytic shapes of every collider a deformable can collide
    // against: Rapier balls, cuboids and capsules, plus floor proxies. Convex
    // hull/trimesh colliders (e.g. the gltf ragdoll parts) are not included.
    this.getColliderShapes = () => {
        const shapes = [];
        objects.forEach(zincObject => {
            if (zincObject.analyticShape) {
                shapes.push(zincObject.analyticShape);
                return;
            }
            const collider = zincObject.worldCollider;
            if (!this.rapier || !collider) return;
            const shapeType = collider.shapeType();
            const ShapeType = this.rapier.ShapeType;
            let shape;
            if (shapeType === ShapeType.Ball) {
                shape = { type: 'sphere', radius: collider.radius() };
            } else if (shapeType === ShapeType.Cuboid) {
                const h = collider.halfExtents();
                shape = { type: 'box', halfExtents: [h.x, h.y, h.z] };
            } else if (shapeType === ShapeType.Capsule) {
                shape = { type: 'capsule', halfHeight: collider.halfHeight(), radius: collider.radius() };
            } else {
                return;
            }
            const t = collider.translation();
            const r = collider.rotation();
            const v = zincObject.rigidBody.linvel();
            shape.position = [t.x, t.y, t.z];
            shape.rotation = [r.x, r.y, r.z, r.w];
            shape.linearVelocity = [v.x, v.y, v.z];
            shapes.push(shape);
        });
        return shapes;
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
            setShadows(zincObject, false, true);
            const options = PhysicsOptions(false, false, false, undefined, undefined, 1.0, 0.0);
            this.addPhysicsToObject(zincObject, options);
            // Same rotation order as the geometry above: X, then Y, then Z.
            const [rx, ry, rz] = rotation ?? [0, 0, 0];
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'ZYX'));
            zincObject.analyticShape = {
                type: 'box',
                position: [...position],
                rotation: [q.x, q.y, q.z, q.w],
                halfExtents: [dimension[0] / 2, dimension[1] / 2, FLOOR_PROXY_HALF_THICKNESS],
                linearVelocity: [0, 0, 0],
            };
            return zincObject;
        } else {
            console.error("Physics engine is not ready yet.");
        }
    }

    this.addWalls = (floorPosition, floorDimension, wallHeight) => {
        const halfX = floorDimension[0] / 2;
        const halfY = floorDimension[1] / 2;
        const wallZ = floorPosition[2] + wallHeight / 2;

        // North/South walls: perpendicular to Y, spanning the floor's X edge
        this.addFloor([floorPosition[0], floorPosition[1] + halfY, wallZ],
            [floorDimension[0], wallHeight], [Math.PI / 2, 0, 0]);
        this.addFloor([floorPosition[0], floorPosition[1] - halfY, wallZ],
            [floorDimension[0], wallHeight], [Math.PI / 2, 0, 0]);

        // East/West walls: perpendicular to X, spanning the floor's Y edge
        this.addFloor([floorPosition[0] + halfX, floorPosition[1], wallZ],
            [wallHeight, floorDimension[1]], [0, Math.PI / 2, 0]);
        this.addFloor([floorPosition[0] - halfX, floorPosition[1], wallZ],
            [wallHeight, floorDimension[1]], [0, Math.PI / 2, 0]);
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

    // Copies the rigid body's translation/rotation (as enabled by physicsT/
    // physicsR) onto the object's mesh.
    const syncMorphToRigidBody = (target) => {
        if (!target.isZincObject) return;
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
                    syncMorphToRigidBody(zincObject);
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
                // Objects loaded by Zinc (loadGLTF/importZincMetadata) bypass
                // addGeometry/addMesh, so give them shadows here.
                setShadows(zincObject, true, true);
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

    const _pickingCallback = function() {
		return function(intersects, window_x, window_y) {

        }
    }

    const _hoverCallback = function() {
		return function(intersects, window_x, window_y) {


        }
    }

    // Casts a ray under the mouse (leaving it in raycaster.ray) and returns the
    // nearest dynamic rigid body hit, if any.
    const pickDraggableObject = (scene, zincCameraControl, raycaster, mouse, event) => {
        zincCameraControl.getNDCFromDocumentCoords(event.clientX, event.clientY, mouse);
        raycaster.setFromCamera(mouse, zincCameraControl.cameraObject);
        if (!this.rapier) return undefined;
        const hits = raycaster.intersectObjects(scene.getPickableThreeJSObjects(), true);
        return hits.find(hit =>
            hit.object?.userData?.isZincObject &&
            hit.object.userData.rigidBody?.bodyType() === this.rapier.RigidBodyType.Dynamic);
    }

    this.enableDragging = () => {
        if (!this.renderer || dragListenersAttached) return;
        dragListenersAttached = true;

        const domElement = this.renderer.getThreeJSRenderer().domElement;
        const scene = this.renderer.getCurrentScene();
        const zincCameraControl = scene.getZincCameraControls();
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();
        const currentPoint = new THREE.Vector3();

        const onMouseDown = (event) => {
            const rigidHit = pickDraggableObject(scene, zincCameraControl, raycaster, mouse, event);

            // Deformables aren't raycastable meshes, so each picks itself; the
            // candidate nearest the camera (rigid or deformable) wins.
            let deformableHit = null;
            let hitDeformable = null;
            deformables.forEach(deformable => {
                if (!deformable.isPickingEnabled()) return;
                const hit = deformable.pick(raycaster.ray);
                if (hit && (!deformableHit || hit.distance < deformableHit.distance)) {
                    deformableHit = hit;
                    hitDeformable = deformable;
                }
            });
            const useDeformable = deformableHit &&
                (!rigidHit || deformableHit.distance < rigidHit.distance);
            if (!useDeformable && !rigidHit) return;

            zincCameraControl.disable();

            const grabPoint = (useDeformable ? deformableHit.point : rigidHit.point).clone();
            const cameraDirection = new THREE.Vector3();
            zincCameraControl.cameraObject.getWorldDirection(cameraDirection);
            const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
                cameraDirection, grabPoint);

            dragState = {
                grabPoint,
                dragPlane,
                lastPoint: grabPoint.clone(),
                lastTime: performance.now(),
                velocity: new THREE.Vector3(),
            };

            if (useDeformable) {
                dragState.deformable = hitDeformable;
                dragState.startTranslation = grabPoint.clone();
                hitDeformable.grab(deformableHit);
            } else {
                const rigidBody = rigidHit.object.userData.rigidBody;
                const t = rigidBody.translation();
                dragState.rigidBody = rigidBody;
                dragState.originalBodyType = rigidBody.bodyType();
                dragState.startTranslation = new THREE.Vector3(t.x, t.y, t.z);
                rigidBody.setBodyType(this.rapier.RigidBodyType.KinematicPositionBased, true);
            }
        }

        const onMouseMove = (event) => {
            if (!dragState) return;

            zincCameraControl.getNDCFromDocumentCoords(event.clientX, event.clientY, mouse);
            raycaster.setFromCamera(mouse, zincCameraControl.cameraObject);
            if (!raycaster.ray.intersectPlane(dragState.dragPlane, currentPoint)) return;

            const newPosition = dragState.startTranslation.clone()
                .add(currentPoint).sub(dragState.grabPoint);

            const now = performance.now();
            const dt = Math.max((now - dragState.lastTime) / 1000, 1e-4);
            dragState.velocity.copy(currentPoint).sub(dragState.lastPoint).divideScalar(dt);
            dragState.lastPoint.copy(currentPoint);
            dragState.lastTime = now;

            if (dragState.deformable) {
                dragState.deformable.moveGrab(newPosition);
            } else {
                dragState.rigidBody.setNextKinematicTranslation(newPosition);
            }
        }

        const onMouseUp = () => {
            if (dragState) {
                if (dragState.deformable) {
                    dragState.deformable.release();
                } else {
                    dragState.rigidBody.setBodyType(dragState.originalBodyType, true);
                    dragState.rigidBody.setLinvel(dragState.velocity, true);
                }
                dragState = null;
            }
            zincCameraControl.enable();
        }

        // Capture phase so this runs before zincjs's own camera mousedown
        // listener (registered earlier, at camera-control creation). Otherwise
        // the camera records a rotate state on the first click, disable() then
        // removes its mouseup so that state is never cleared, and the view
        // tumbles after the drag ends.
        domElement.addEventListener('mousedown', onMouseDown, { capture: true });
        domElement.addEventListener('mousemove', onMouseMove);
        domElement.addEventListener('mouseup', onMouseUp);
        domElement.addEventListener('mouseleave', onMouseUp);
    }

    const downloadCompletedCallback = () => {
        return () => {
            downloadCompletedCallbacks.forEach(callback => {
                callback();
            })
            this.startSimulation();
            const scene = this.renderer.getCurrentScene();
            const zincCameraControl = scene.getZincCameraControls();
			//zincCameraControl.enableRaycaster(scene, _pickingCallback(), _hoverCallback());
            scene.viewAll();
        }
    }

    // Starts the render loop and per-frame physics stepping. Called
    // automatically once a gltf/metadata download completes; call it directly
    // for scenes built only from primitives and deformables.
    this.startSimulation = () => {
        if (!this.renderer || simulationStarted) return;
        simulationStarted = true;
        this.renderer.addPreRenderCallbackFunction(updatePhysicalWorld());
        this.renderer.playAnimation = true;
        this.renderer.animate();
        this.enableDragging();
    }

    const updatePhysicalWorld = () => {
        return () => {
            if (paused) return;
            if (this.physicsWorld) {
                this.physicsWorld.step();
                objects.forEach(syncMorphToRigidBody);
            }
            if (deformables.length > 0) {
                const shapes = this.getColliderShapes();
                deformables.forEach(deformable => {
                    deformable.setColliders(shapes);
                    deformable.step();
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
            return scene;
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
        objects.forEach(object => {
            delete object.worldCollider;
        });
        objects.length = 0;
        joints.length = 0;
        deformables.forEach(deformable => deformable.dispose());
        deformables.length = 0;
        lights.forEach(({ light, scene }) => {
            scene.removeObject(light.target);
            scene.removeObject(light);
            light.dispose();
        });
        lights.length = 0;
        this.physicsWorld = undefined;
        if (this.renderer) {
            this.renderer.dispose();
        }
    }
}

export { PhyZinc, PhysicsOptions, JointOptions };
