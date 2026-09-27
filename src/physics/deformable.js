// Base class for simulated (non-Rapier) deformable objects, such as a
// ClothPatch, that PhyZinc steps alongside the rigid-body world. Register one
// with PhyZinc.addDeformable(); PhyZinc then, every unpaused frame after the
// Rapier step, calls setColliders() with the current rigid colliders and then
// step(), and routes mouse dragging to pick()/grab()/moveGrab()/release().
//
// Subclasses must set `mesh` and implement step(). The other methods default
// to no-ops, so a deformable that doesn't collide or can't be dragged simply
// leaves them alone.
class Deformable {
    constructor() {
        // THREE.Mesh added to the scene by PhyZinc.addDeformable().
        this.mesh = null;
        this.pickingEnabled = true;
        this.collisionFeedbackEnabled = false;
    }

    // Whether this deformable pushes back on the rigid bodies it touches
    // (two-way coupling). Off by default, since it costs a GPU readback per
    // step; subclasses override to start/stop that work, calling super first.
    setCollisionFeedback(enabled) {
        this.collisionFeedbackEnabled = enabled;
    }

    isCollisionFeedbackEnabled() {
        return this.collisionFeedbackEnabled;
    }

    // Impulses this deformable has applied to rigid colliders since the last
    // call, as [{ rigidBody, impulse: [x, y, z], torque: [x, y, z] }] (N·s and
    // N·m·s, world space; torque about the body's centre). PhyZinc applies them
    // before each Rapier step.
    takeColliderImpulses() {
        return [];
    }

    // Whether PhyZinc should offer this deformable to mouse picking/dragging.
    // Subclasses that pay for picking (e.g. a GPU readback) override this to
    // start or stop that work, calling super.setPickingEnabled() first.
    setPickingEnabled(enabled) {
        this.pickingEnabled = enabled;
    }

    isPickingEnabled() {
        return this.pickingEnabled;
    }

    // Advances the simulation by one fixed time step.
    step() {
        throw new Error(`${this.constructor.name} must implement step()`);
    }

    // shapes: world-space analytic colliders, as returned by
    // PhyZinc.getColliderShapes(). Called before each step().
    // eslint-disable-next-line no-unused-vars
    setColliders(shapes) {}

    // ray: world-space THREE.Ray under the mouse. Returns a hit
    // { point: THREE.Vector3, distance (along the ray), ... } or null; PhyZinc
    // passes the same hit back to grab() if this is the nearest object.
    // eslint-disable-next-line no-unused-vars
    pick(ray) {
        return null;
    }

    // eslint-disable-next-line no-unused-vars
    grab(hit) {}

    // point: world-space THREE.Vector3 the grabbed part should follow.
    // eslint-disable-next-line no-unused-vars
    moveGrab(point) {}

    release() {}

    // Frees GPU/CPU resources. Called by PhyZinc.dispose().
    dispose() {}
}

export { Deformable };
