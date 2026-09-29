import Zinc from "zincjs";
import { Deformable } from "./deformable.js";
const THREE = Zinc.THREE;
const {
    Fn, attributeArray, instanceIndex, uniform, vec3, vec4, float, int, select, sin, Loop, If, atomicAdd,
    transformNormalToView, faceDirection
} = THREE.TSL;

// Maximum number of rigid colliders the cloth can collide against per step.
const MAX_COLLIDERS = 64;
// vec4 slots per collider in the collider buffer (see setColliders).
const COLLIDER_STRIDE = 4;
// Shape type codes. The first three match Rapier's ShapeType numbering;
// convexHull does not (Rapier's is 9), as the codes are only read by the kernel.
const SHAPE_TYPES = { sphere: 0, box: 1, capsule: 2, convexHull: 3 };
// Total face planes shared by all convex-hull colliders per step.
const MAX_HULL_PLANES = 2048;
// int slots per collider in the impulse buffer: [Jx, Jy, Jz, τx, τy, τz, -, -].
const IMPULSE_STRIDE = 8;
// WGSL atomics are integer-only, so impulses are summed as fixed-point i32:
// 1e8 units per N·s gives ±21 N·s per collider per step, far above anything a
// cloth transfers, with 1e-8 N·s resolution.
const IMPULSE_SCALE = 1e8;
// Impulse readbacks allowed in flight; a step beyond this is not fed back.
const MAX_IMPULSE_READBACKS = 4;

// Proof-of-concept WebGPU XPBD (extended Position-Based-Dynamics) cloth patch.
// Stretch/bend stiffness is set by compliance (inverse stiffness, α = 1/k), so
// it is a material property rather than an artefact of iteration count.
// No Rapier dependency: rigid bodies are passed in as analytic shapes via
// setColliders() (one-way coupling — bodies push the cloth, the cloth does not
// push back). Positions stay GPU-resident, feeding the node material's
// positionNode directly with zero CPU readback.
//
// pin: 'topCorners' | 'corners' | 'edges' | 'none'.
// colDirection/rowDirection: unit world axes the grid's columns/rows step
// along from origin (default: a vertical curtain in the XZ plane).
// texture: optional THREE.Texture mapped over the whole patch (UV 0..1 spans
// the grid); null uses a built-in black and white checkerboard.
// particleMass: kg per particle (default 1 g). Used by XPBD and by the
// impulses fed back to rigid bodies when collision feedback is enabled.
// feedbackScale: multiplier on those impulses (1 = physical).
const ClothOptions = function(gridWidth, gridHeight, spacing, origin,
    pin, gravity, damping, solverIterations, stretchCompliance, bendCompliance,
    colDirection, rowDirection, collisionThickness, friction, texture,
    particleMass, feedbackScale) {
    return {
        gridWidth: gridWidth ?? 20,
        gridHeight: gridHeight ?? 20,
        spacing: spacing ?? 0.1,
        origin: origin ?? [0, 0, 0],
        pin: pin ?? 'topCorners',
        gravity: gravity ?? [0, 0, -9.81],
        damping: damping ?? 0.98,
        solverIterations: solverIterations ?? 20,
        // Compliance α = 1/stiffness (m/N). 0 = rigid link; larger = softer.
        // Bending is much softer than stretch, like real fabric. XPBD weighs α
        // against inverse mass, so these defaults suit the default 1 g
        // particles; scale them with particleMass to keep the same look.
        stretchCompliance: stretchCompliance ?? 1e-8,
        bendCompliance: bendCompliance ?? 1e-6,
        colDirection: colDirection ?? [1, 0, 0],
        rowDirection: rowDirection ?? [0, 0, -1],
        // Distance particles are kept from collider surfaces.
        collisionThickness: collisionThickness ?? (spacing ?? 0.1) * 0.25,
        // 0 = frictionless sliding, 1 = cloth sticks to the surface it touches.
        friction: friction ?? 0.5,
        texture: texture ?? null,
        particleMass: particleMass ?? 0.001,
        feedbackScale: feedbackScale ?? 1
    };
}

// Default cloth texture: a checks x checks black and white checkerboard, one
// texel per square, sampled with NearestFilter so the squares stay crisp.
const createCheckerTexture = (checks = 8) => {
    const data = new Uint8Array(checks * checks * 4);
    for (let row = 0; row < checks; row++) {
        for (let col = 0; col < checks; col++) {
            const value = (row + col) % 2 === 0 ? 255 : 0;
            data.set([value, value, value, 255], (row * checks + col) * 4);
        }
    }
    const texture = new THREE.DataTexture(data, checks, checks);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
}

// Grid position of particle (col, row), shared by the CPU placeholder geometry
// and the GPU init kernel so the two always agree.
const gridPoint = (origin, colDirection, rowDirection, spacing, col, row) => [0, 1, 2].map(axis =>
    origin[axis] + (colDirection[axis] * col + rowDirection[axis] * row) * spacing);

// Static placeholder geometry: topology and UVs only matter, since the
// material's positionNode and normalNode read the GPU buffers instead.
const buildGeometry = (gridWidth, gridHeight, spacing, origin, colDirection, rowDirection) => {
    const geometry = new THREE.BufferGeometry();
    const count = gridWidth * gridHeight;
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    for (let row = 0; row < gridHeight; row++) {
        for (let col = 0; col < gridWidth; col++) {
            const i = row * gridWidth + col;
            positions.set(gridPoint(origin, colDirection, rowDirection, spacing, col, row), i * 3);
            uvs[i * 2 + 0] = col / (gridWidth - 1);
            uvs[i * 2 + 1] = row / (gridHeight - 1);
        }
    }
    const indices = [];
    for (let row = 0; row < gridHeight - 1; row++) {
        for (let col = 0; col < gridWidth - 1; col++) {
            const a = row * gridWidth + col;
            const b = a + 1;
            const c = a + gridWidth;
            const d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}

// Under-relaxation for the Jacobi-style solver: a particle can receive up to 8
// summed corrections per iteration (4 structural + 4 bending neighbors), and
// applying them at full strength reliably overshoots and oscillates. Roughly
// Macklin et al. 2014's ω/n with ω≈1.5, n=8.
const RELAXATION = 0.2;

// One XPBD distance constraint between this particle and a neighbor
// (Macklin, Müller & Chentanez 2016, eq. 18):
//   C = |x_self - x_nb| - restLen,  n = (x_self - x_nb) / |x_self - x_nb|
//   Δλ = (-C - α̃·λ) / (w_self + w_nb + α̃),  α̃ = compliance / dt²
//   Δx_self = w_self · n · Δλ
// Both endpoint threads compute the identical Δλ from the same read buffer, so
// each particle keeps its own copy of λ for each of its constraints and only
// ever writes its own slot — race-free, no atomics. `valid` masks neighbors
// past the grid edge (index falls back to self, contribution forced to 0).
// invMassOf(index) returns a particle's effective inverse mass node.
// Returns { dLambda, correction } nodes.
const xpbdConstraint = (i, selfPos, selfInvMass, readBuf, invMassOf, valid, neighborIndex,
    restLen, lambda, alphaTilde) => {
    const index = valid.select(neighborIndex, i);
    const neighborInvMass = invMassOf(index);
    const diff = selfPos.sub(readBuf.element(index));
    const len = diff.length().max(1e-5);
    const constraint = len.sub(restLen);
    const wSum = selfInvMass.add(neighborInvMass);
    const mask = select(valid.and(wSum.greaterThan(0.0)), float(1.0), float(0.0));
    const dLambda = constraint.negate().sub(alphaTilde.mul(lambda))
        .div(wSum.add(alphaTilde).max(1e-8))
        .mul(RELAXATION).mul(mask).toVar();
    const correction = diff.div(len).mul(selfInvMass).mul(dLambda);
    return { dLambda, correction };
}

// normalize() that returns zero, not NaN, for a (near-)zero vector. WGSL's
// normalize(0) is NaN, and one NaN particle spreads through the constraints
// until the whole cloth vanishes. Multiplying a NaN normal by zero (no wind,
// no penetration) is still NaN, so the guard is needed even where unused.
const safeNormalize = (v) => v.div(v.length().max(1e-12));

// Rotates v by unit quaternion q (xyz = vector part, w = scalar part):
// v' = v + w·t + u×t, with u = q.xyz and t = 2·(u×v).
const rotateByQuaternion = (q, v) => {
    const t = q.xyz.cross(v).mul(2.0);
    return v.add(t.mul(q.w)).add(q.xyz.cross(t));
}

// Signed distance from a point in the collider's local frame to its surface
// (negative inside). All three shapes are evaluated and one is selected, which
// avoids divergent branches on the GPU. params: sphere x=radius; box
// xyz=half extents; capsule x=half height (along local Y, as in Rapier), y=radius.
// Convex hulls are handled separately in colliderContact.
const localDistance = (local, type, params) => {
    const dSphere = local.length().sub(params.x);
    const q = local.abs().sub(params.xyz);
    const dBox = q.max(0.0).length().add(q.x.max(q.y).max(q.z).min(0.0));
    const axial = local.y.clamp(params.x.negate(), params.x);
    const dCapsule = vec3(local.x, local.y.sub(axial), local.z).length().sub(params.y);
    return select(type.lessThan(0.5), dSphere, select(type.lessThan(1.5), dBox, dCapsule));
}

class ClothPatch extends Deformable {
    // Builds every GPU buffer and compute kernel (synchronously, like any
    // three.js node setup). Call initialise() before the first step().
    constructor(renderer, options) {
        super();
        const opts = ClothOptions(
            options?.gridWidth, options?.gridHeight, options?.spacing, options?.origin,
            options?.pin, options?.gravity, options?.damping, options?.solverIterations,
            options?.stretchCompliance, options?.bendCompliance, options?.colDirection,
            options?.rowDirection, options?.collisionThickness, options?.friction,
            options?.texture, options?.particleMass, options?.feedbackScale
        );
        const {
            gridWidth, gridHeight, spacing, origin, pin, gravity, damping, solverIterations,
            stretchCompliance, bendCompliance, colDirection, rowDirection, collisionThickness, friction,
            particleMass
        } = opts;
        const particleCount = gridWidth * gridHeight;

        // attributeArray (StorageBufferAttribute), not instancedArray
        // (StorageInstancedBufferAttribute) — this Mesh is a regular, non-instanced
        // draw, so a per-instance buffer would have every vertex read element(0)
        // (instance_index is always 0), collapsing the whole mesh to one point.
        const positionSettled = attributeArray(particleCount, 'vec3');
        const positionScratchA = attributeArray(particleCount, 'vec3');
        const positionScratchB = attributeArray(particleCount, 'vec3');
        const velocity = attributeArray(particleCount, 'vec3');
        const invMass = attributeArray(particleCount, 'float');
        // XPBD Lagrange multipliers, one per constraint per particle (see
        // xpbdConstraint). Slots: x=left y=right z=up w=down.
        const lambdaStructural = attributeArray(particleCount, 'vec4');
        const lambdaBending = attributeArray(particleCount, 'vec4');
        // Rigid colliders, written from the CPU each step by setColliders(). Per
        // collider, COLLIDER_STRIDE vec4s: [position, type], [rotation quaternion],
        // [shape params], [linear velocity, unused]. Convex hulls' params are
        // x=first plane, y=plane count into hullPlanes.
        const colliderData = attributeArray(MAX_COLLIDERS * COLLIDER_STRIDE, 'vec4');
        // Convex-hull face planes in their collider's local frame: xyz=outward
        // normal, w=offset d (n·p = d on the face).
        const hullPlanes = attributeArray(MAX_HULL_PLANES, 'vec4');

        const gridWidthU = uniform(gridWidth, 'int');
        const gridHeightU = uniform(gridHeight, 'int');
        const restLengthU = uniform(spacing, 'float');
        const restLength2U = uniform(spacing * 2, 'float');
        const gravityU = uniform(new THREE.Vector3(gravity[0], gravity[1], gravity[2]));
        const dampingU = uniform(damping, 'float');
        const dt = 1 / 60;
        const dtU = uniform(dt, 'float');
        const windU = uniform(new THREE.Vector3(0, 0, 0));
        const gustU = uniform(0.0, 'float');
        const timeU = uniform(0.0, 'float');
        // α̃ = α / dt² (time-step-scaled compliance), precomputed on the CPU.
        const stretchAlphaTildeU = uniform(stretchCompliance / (dt * dt), 'float');
        const bendAlphaTildeU = uniform(bendCompliance / (dt * dt), 'float');
        // Index of the particle held by the mouse (-1 = none) and where it's held.
        const grabIndexU = uniform(-1, 'int');
        const grabTargetU = uniform(new THREE.Vector3());
        // Effective inverse mass: a grabbed particle is treated as pinned, so its
        // neighbours are pulled towards it and nothing pulls it back.
        const invMassOf = (index) =>
            select(index.equal(grabIndexU), float(0.0), invMass.element(index));
        const colliderCountU = uniform(0, 'int');
        const thicknessU = uniform(collisionThickness, 'float');
        const frictionU = uniform(friction, 'float');
        // Collision feedback: impulses the cloth applies to each collider this
        // step, summed with atomics (many particles touch one collider at once)
        // and read back by step(). feedbackU is 0 when feedback is disabled.
        const impulseData = attributeArray(MAX_COLLIDERS * IMPULSE_STRIDE, 'int').toAtomic();
        const feedbackU = uniform(0.0, 'float');
        // Mass for momentum bookkeeping: 0 for pinned and grabbed particles,
        // which are held by an "infinite" hand and so transfer nothing.
        const massOf = (index) => {
            const w = invMassOf(index);
            return select(w.greaterThan(0.0), float(1.0).div(w), float(0.0));
        }
        // Adds impulse J (N·s, world space, applied at point p) to collider k,
        // with its torque about the collider's centre.
        const addColliderImpulse = (k, impulse, p, center) => {
            const scaled = impulse.mul(feedbackU).mul(IMPULSE_SCALE);
            const torque = p.sub(center).cross(impulse).mul(feedbackU).mul(IMPULSE_SCALE);
            const base = k.mul(IMPULSE_STRIDE);
            atomicAdd(impulseData.element(base), scaled.x.round().toInt());
            atomicAdd(impulseData.element(base.add(1)), scaled.y.round().toInt());
            atomicAdd(impulseData.element(base.add(2)), scaled.z.round().toInt());
            atomicAdd(impulseData.element(base.add(3)), torque.x.round().toInt());
            atomicAdd(impulseData.element(base.add(4)), torque.y.round().toInt());
            atomicAdd(impulseData.element(base.add(5)), torque.z.round().toInt());
        }

        // Distance and outward normal from world point p to collider k's surface.
        // For analytic shapes the normal is the central-difference gradient of
        // the local distance field. A convex hull's distance is the max over its
        // face planes of n·p - d (exact inside and on faces, slightly short
        // near outside edges and corners), with that plane's n as the normal.
        // Every thread tests the same collider k, so the branch does not diverge.
        const colliderContact = (p, k) => {
            const base = k.mul(COLLIDER_STRIDE);
            const header = colliderData.element(base).toVar();
            const rotation = colliderData.element(base.add(1)).toVar();
            const params = colliderData.element(base.add(2)).toVar();
            const type = header.w;
            const inverseRotation = vec4(rotation.xyz.negate(), rotation.w);
            const local = rotateByQuaternion(inverseRotation, p.sub(header.xyz)).toVar();
            const distance = float(0.0).toVar();
            const localNormal = vec3(0, 0, 0).toVar();
            If(type.greaterThan(2.5), () => {
                const start = params.x.toInt();
                distance.assign(-1e30);
                Loop({ start, end: start.add(params.y.toInt()), type: 'int', condition: '<', name: 'plane' },
                    ({ plane }) => {
                        const facePlane = hullPlanes.element(plane);
                        const d = facePlane.xyz.dot(local).sub(facePlane.w);
                        If(d.greaterThan(distance), () => {
                            distance.assign(d);
                            localNormal.assign(facePlane.xyz);
                        });
                    });
            }).Else(() => {
                const h = 1e-4;
                localNormal.assign(safeNormalize(vec3(
                    localDistance(local.add(vec3(h, 0, 0)), type, params)
                        .sub(localDistance(local.sub(vec3(h, 0, 0)), type, params)),
                    localDistance(local.add(vec3(0, h, 0)), type, params)
                        .sub(localDistance(local.sub(vec3(0, h, 0)), type, params)),
                    localDistance(local.add(vec3(0, 0, h)), type, params)
                        .sub(localDistance(local.sub(vec3(0, 0, h)), type, params))
                )));
                distance.assign(localDistance(local, type, params));
            });
            const normal = rotateByQuaternion(rotation, localNormal);
            const bodyVelocity = colliderData.element(base.add(3)).xyz;
            return { distance, normal, bodyVelocity, center: header.xyz };
        }

        const initKernel = Fn(() => {
            const i = instanceIndex.toInt();
            const col = i.mod(gridWidthU);
            const row = i.div(gridWidthU);

            const pos = vec3(...origin)
                .add(vec3(...colDirection).mul(col.toFloat().mul(restLengthU)))
                .add(vec3(...rowDirection).mul(row.toFloat().mul(restLengthU)));
            positionSettled.element(i).assign(pos);
            velocity.element(i).assign(vec3(0, 0, 0));
            lambdaStructural.element(i).assign(vec4(0, 0, 0, 0));
            lambdaBending.element(i).assign(vec4(0, 0, 0, 0));

            const firstCol = col.equal(0);
            const lastCol = col.equal(gridWidthU.sub(1));
            const firstRow = row.equal(0);
            const lastRow = row.equal(gridHeightU.sub(1));
            const pinnedByMode = {
                topCorners: () => firstRow.and(firstCol.or(lastCol)),
                corners: () => firstRow.or(lastRow).and(firstCol.or(lastCol)),
                edges: () => firstRow.or(lastRow).or(firstCol).or(lastCol),
                none: () => col.equal(-1), // never true
            };
            if (!pinnedByMode[pin]) {
                throw new Error(`Unknown cloth pin mode "${pin}"`);
            }
            const pinned = pinnedByMode[pin]();
            invMass.element(i).assign(select(pinned, float(0.0), float(1.0 / particleMass)));
        })().compute(particleCount);

        const predictKernel = Fn(() => {
            const i = instanceIndex.toInt();
            const col = i.mod(gridWidthU);
            const row = i.div(gridWidthU);
            const selfInvMass = invMassOf(i);
            const vel = velocity.element(i).toVar();

            // Surface normal from central differences over grid neighbours (clamped
            // at the edges). Reads positionSettled only, which nothing writes during
            // this pass, so neighbour reads are race-free.
            // int() explicitly: a bare JS number is typed float in TSL, and a
            // float offset in integer index arithmetic fails WGSL validation.
            const left = i.sub(col.greaterThan(0).select(int(1), int(0)));
            const right = i.add(col.lessThan(gridWidthU.sub(1)).select(int(1), int(0)));
            const up = i.sub(row.greaterThan(0).select(gridWidthU, int(0)));
            const down = i.add(row.lessThan(gridHeightU.sub(1)).select(gridWidthU, int(0)));
            const tangentU = positionSettled.element(right).sub(positionSettled.element(left));
            const tangentV = positionSettled.element(down).sub(positionSettled.element(up));
            const normal = safeNormalize(tangentU.cross(tangentV));

            // Aerodynamic-style force: only the component of relative wind along the
            // normal pushes the cloth (air sliding along the surface does little),
            // and relative wind includes the particle's own velocity so a surface
            // already moving with the wind is pushed less. The gust term varies over
            // time and across the patch so it flutters instead of holding one bulge.
            const gust = sin(timeU.mul(2.3).add(col.toFloat().mul(0.35)).add(row.toFloat().mul(0.2)))
                .mul(0.5).add(0.5).mul(gustU).add(1.0);
            const relativeWind = windU.mul(gust).sub(vel);
            const windForce = normal.mul(normal.dot(relativeWind));

            // Gravity and wind are accelerations; the mask only stops pinned or
            // grabbed particles from moving.
            const movable = select(selfInvMass.greaterThan(0.0), float(1.0), float(0.0));
            vel.assign(vel.add(gravityU.add(windForce).mul(dtU).mul(movable)).mul(dampingU));
            velocity.element(i).assign(vel);
            // XPBD: λ accumulates over one timestep's iterations, reset every step.
            lambdaStructural.element(i).assign(vec4(0, 0, 0, 0));
            lambdaBending.element(i).assign(vec4(0, 0, 0, 0));
            const predicted = positionSettled.element(i).add(vel.mul(dtU));
            positionScratchA.element(i).assign(select(i.equal(grabIndexU), grabTargetU, predicted));
        })().compute(particleCount);

        const buildSolveKernel = (readBuf, writeBuf) => Fn(() => {
            const i = instanceIndex.toInt();
            const col = i.mod(gridWidthU);
            const row = i.div(gridWidthU);
            const selfInvMass = invMassOf(i);
            const selfPos = readBuf.element(i).toVar();
            const structLambda = lambdaStructural.element(i).toVar();
            const bendLambda = lambdaBending.element(i).toVar();

            const solve = (valid, neighborIndex, restLen, lambda, alphaTilde) =>
                xpbdConstraint(i, selfPos, selfInvMass, readBuf, invMassOf, valid, neighborIndex,
                    restLen, lambda, alphaTilde);

            // structural (adjacent grid neighbors): λ slots x=left y=right z=up w=down
            const sLeft = solve(col.greaterThan(0), i.sub(1), restLengthU, structLambda.x, stretchAlphaTildeU);
            const sRight = solve(col.lessThan(gridWidthU.sub(1)), i.add(1), restLengthU, structLambda.y, stretchAlphaTildeU);
            const sUp = solve(row.greaterThan(0), i.sub(gridWidthU), restLengthU, structLambda.z, stretchAlphaTildeU);
            const sDown = solve(row.lessThan(gridHeightU.sub(1)), i.add(gridWidthU), restLengthU, structLambda.w, stretchAlphaTildeU);

            // bending (2-away grid neighbors), same slot layout
            const bLeft = solve(col.greaterThan(1), i.sub(2), restLength2U, bendLambda.x, bendAlphaTildeU);
            const bRight = solve(col.lessThan(gridWidthU.sub(2)), i.add(2), restLength2U, bendLambda.y, bendAlphaTildeU);
            const bUp = solve(row.greaterThan(1), i.sub(gridWidthU.mul(2)), restLength2U, bendLambda.z, bendAlphaTildeU);
            const bDown = solve(row.lessThan(gridHeightU.sub(2)), i.add(gridWidthU.mul(2)), restLength2U, bendLambda.w, bendAlphaTildeU);

            const all = [sLeft, sRight, sUp, sDown, bLeft, bRight, bUp, bDown];
            const correction = all.reduce((sum, c) => sum.add(c.correction), vec3(0, 0, 0));

            lambdaStructural.element(i).assign(structLambda.add(
                vec4(sLeft.dLambda, sRight.dLambda, sUp.dLambda, sDown.dLambda)));
            lambdaBending.element(i).assign(bendLambda.add(
                vec4(bLeft.dLambda, bRight.dLambda, bUp.dLambda, bDown.dLambda)));

            // Safety clamp: cap the correction magnitude so a transient numerical
            // issue can't explode a position in one iteration. Should never engage
            // in normal running (it would desync λ from the applied correction).
            const correctionLen = correction.length();
            const maxCorrectionLen = restLengthU.mul(0.5);
            const clampedLen = correctionLen.clamp(0.0, maxCorrectionLen);
            const safeCorrection = correction.mul(clampedLen.div(correctionLen.max(1e-6)));

            // Collision constraints (inequality, C = distance - thickness >= 0):
            // project the particle out of any collider it has entered. Applied every
            // iteration so the distance constraints solve around the obstacles.
            const newPos = selfPos.add(safeCorrection).toVar();
            const movable = select(selfInvMass.greaterThan(0.0), float(1.0), float(0.0));
            const selfMass = massOf(i);
            Loop({ start: int(0), end: colliderCountU, type: 'int', condition: '<' }, ({ i: k }) => {
                const contact = colliderContact(newPos, k);
                const penetration = thicknessU.sub(contact.distance).max(0.0);
                const push = contact.normal.mul(penetration).mul(movable).toVar();
                newPos.addAssign(push);
                // Momentum conservation: the particle gained m·Δx/Δt, so the
                // body receives the opposite. Summed over every iteration this
                // is the contact constraint's accumulated λ.
                If(penetration.greaterThan(0.0).and(feedbackU.greaterThan(0.0)), () => {
                    addColliderImpulse(k, push.mul(selfMass).div(dtU).negate(), newPos, contact.center);
                });
            });

            // Surface samples: particles alone let a sharp feature (a box corner or
            // edge) slip between them and poke through a triangle. So also test the
            // midpoint of each incident edge and the centre of each incident quad.
            // A sample at Σ w_j·x_j with equal weights and masses is projected out
            // by moving every contributing particle by the full penetration along
            // the normal. Every particle sharing a sample computes it identically
            // from readBuf and applies only its own share (race-free, as with the
            // distance constraints); per collider, pushes are averaged over the
            // penetrating samples so overlapping ones don't overshoot.
            const W = gridWidthU;
            const hasLeft = col.greaterThan(0);
            const hasRight = col.lessThan(W.sub(1));
            const hasUp = row.greaterThan(0);
            const hasDown = row.lessThan(gridHeightU.sub(1));
            const at = (valid, index) => readBuf.element(valid.select(index, i));
            const self = readBuf.element(i).toVar();
            const pLeft = at(hasLeft, i.sub(1)).toVar();
            const pRight = at(hasRight, i.add(1)).toVar();
            const pUp = at(hasUp, i.sub(W)).toVar();
            const pDown = at(hasDown, i.add(W)).toVar();
            const edgeMid = (p) => self.add(p).mul(0.5);
            const quadMid = (valid, a, b, diagIndex) =>
                self.add(a).add(b).add(at(valid, diagIndex)).mul(0.25);
            const upLeft = hasUp.and(hasLeft);
            const upRight = hasUp.and(hasRight);
            const downLeft = hasDown.and(hasLeft);
            const downRight = hasDown.and(hasRight);
            const samples = [
                [hasLeft, edgeMid(pLeft)],
                [hasRight, edgeMid(pRight)],
                [hasUp, edgeMid(pUp)],
                [hasDown, edgeMid(pDown)],
                [upLeft, quadMid(upLeft, pUp, pLeft, i.sub(W).sub(1))],
                [upRight, quadMid(upRight, pUp, pRight, i.sub(W).add(1))],
                [downLeft, quadMid(downLeft, pDown, pLeft, i.add(W).sub(1))],
                [downRight, quadMid(downRight, pDown, pRight, i.add(W).add(1))],
            ];
            Loop({ start: int(0), end: colliderCountU, type: 'int', condition: '<' }, ({ i: k }) => {
                const samplePush = vec3(0, 0, 0).toVar();
                const sampleHits = float(0.0).toVar();
                const center = vec3(0, 0, 0).toVar();
                for (const [valid, sample] of samples) {
                    const contact = colliderContact(sample, k);
                    const penetration = thicknessU.sub(contact.distance).max(0.0)
                        .mul(select(valid, float(1.0), float(0.0))).toVar();
                    If(penetration.greaterThan(0.0), () => {
                        samplePush.addAssign(contact.normal.mul(penetration));
                        sampleHits.addAssign(1.0);
                        center.assign(contact.center);
                    });
                }
                const push = samplePush.div(sampleHits.max(1.0)).mul(movable).toVar();
                newPos.addAssign(push);
                If(sampleHits.greaterThan(0.0).and(feedbackU.greaterThan(0.0)), () => {
                    addColliderImpulse(k, push.mul(selfMass).div(dtU).negate(), newPos, center);
                });
            });

            writeBuf.element(i).assign(newPos);
        })().compute(particleCount);

        const solveAtoB = buildSolveKernel(positionScratchA, positionScratchB);
        const solveBtoA = buildSolveKernel(positionScratchB, positionScratchA);

        const finaliseKernel = Fn(() => {
            const i = instanceIndex.toInt();
            const oldPos = positionSettled.element(i).toVar();
            const finalPos = positionScratchA.element(i).toVar();
            const vel = finalPos.sub(oldPos).div(dtU).toVar();
            const selfMass = massOf(i);

            // Friction, applied once per step at velocity level: for particles in
            // contact, remove a fraction of the tangential velocity relative to the
            // touching body, so cloth grips (and is carried by) moving bodies.
            Loop({ start: int(0), end: colliderCountU, type: 'int', condition: '<' }, ({ i: k }) => {
                const contact = colliderContact(finalPos, k);
                const touching = select(contact.distance.lessThan(thicknessU.mul(1.05)),
                    float(1.0), float(0.0));
                const relative = vel.sub(contact.bodyVelocity);
                const tangential = relative.sub(contact.normal.mul(relative.dot(contact.normal)));
                const frictionDelta = tangential.mul(frictionU).mul(touching).toVar();
                vel.subAssign(frictionDelta);
                // The tangential momentum the cloth lost goes into the body.
                If(touching.greaterThan(0.0).and(feedbackU.greaterThan(0.0)), () => {
                    addColliderImpulse(k, frictionDelta.mul(selfMass), finalPos, contact.center);
                });
            });

            velocity.element(i).assign(vel);
            positionSettled.element(i).assign(finalPos);
        })().compute(particleCount);

        const frameNodes = [predictKernel];
        for (let n = 0; n < solverIterations; n++) {
            frameNodes.push(n % 2 === 0 ? solveAtoB : solveBtoA);
        }
        // solverIterations must be even (default 20) so the last solve pass always
        // writes into positionScratchA, matching finaliseKernel's read above.
        frameNodes.push(finaliseKernel);

        // Per-particle surface normal for lighting, from central differences of
        // the settled positions (one-sided at the grid edges). cross(dRow, dCol)
        // matches buildGeometry's (a, c, b) winding, so it points out of the
        // front face.
        const normal = attributeArray(particleCount, 'vec3');
        const normalKernel = Fn(() => {
            const i = instanceIndex.toInt();
            const col = i.mod(gridWidthU);
            const row = i.div(gridWidthU);
            const rowStart = row.mul(gridWidthU);
            const left = rowStart.add(col.sub(1).max(int(0)));
            const right = rowStart.add(col.add(1).min(gridWidthU.sub(1)));
            const up = row.sub(1).max(int(0)).mul(gridWidthU).add(col);
            const down = row.add(1).min(gridHeightU.sub(1)).mul(gridWidthU).add(col);
            const dCol = positionSettled.element(right).sub(positionSettled.element(left));
            const dRow = positionSettled.element(down).sub(positionSettled.element(up));
            normal.element(i).assign(safeNormalize(dRow.cross(dCol)));
        })().compute(particleCount);
        frameNodes.push(normalKernel);

        const geometry = buildGeometry(gridWidth, gridHeight, spacing, origin, colDirection, rowDirection);
        const material = new THREE.MeshLambertNodeMaterial({
            side: THREE.DoubleSide
        });
        material.positionNode = positionSettled.toAttribute();
        // The mesh has an identity transform, so the world-space normal buffer is
        // also local space. normalNode is in view space and, unlike the built-in
        // normal, isn't flipped for back faces, so faceDirection does that here.
        material.normalNode = transformNormalToView(normal.toAttribute()).mul(faceDirection);
        const mesh = new THREE.Mesh(geometry, material);
        // The CPU bounding volume only reflects the placeholder geometry, not the
        // GPU-deformed surface, so culling against it can wrongly hide the cloth.
        mesh.frustumCulled = false;

        this.mesh = mesh;
        this.options = opts;
        this.renderer = renderer;
        this.dt = dt;
        this.particleCount = particleCount;
        this.positionSettled = positionSettled;
        this.colliderData = colliderData;
        this.hullPlanes = hullPlanes;
        this.impulseData = impulseData;
        this.feedbackScale = opts.feedbackScale;
        // Shapes currently in each collider slot, so a readback's slot k can
        // be matched back to its rigid body.
        this.colliderSlots = [];
        this.pendingImpulses = [];
        this.impulseReadbacks = 0;
        // Bumped when feedback is disabled, so late readbacks are discarded.
        this.feedbackGeneration = 0;
        this.initKernel = initKernel;
        this.normalKernel = normalKernel;
        this.frameNodes = frameNodes;
        this.geometry = geometry;
        this.material = material;
        this.defaultTexture = null;
        this.setTexture(opts.texture);
        this.uniforms = {
            time: timeU, wind: windU, gust: gustU,
            stretchAlphaTilde: stretchAlphaTildeU, bendAlphaTilde: bendAlphaTildeU,
            grabIndex: grabIndexU, grabTarget: grabTargetU, colliderCount: colliderCountU,
            feedback: feedbackU,
        };

        // CPU copy of the particle positions, used only for mouse picking. Read
        // back from the GPU at most once in flight, so it lags 1-2 frames behind.
        // three.js pads vec3 storage to vec4, so particle i is at [4i, 4i + 3).
        this.pickSnapshot = null;
        this.readbackPending = false;
    }

    // Seeds every particle buffer on the GPU. Must complete before the mesh is
    // rendered or step() is called, so no frame compute reads unseeded buffers.
    async initialise() {
        await this.renderer.getThreeJSRenderer().computeAsync(this.initKernel);
        await this.renderer.getThreeJSRenderer().computeAsync(this.normalKernel);
        this.refreshPickSnapshot();
    }

    // Picking needs a CPU copy of the positions, read back from the GPU every
    // step, so disabling it also stops that readback and drops the copy.
    setPickingEnabled(enabled) {
        super.setPickingEnabled(enabled);
        if (enabled) {
            this.refreshPickSnapshot();
        } else {
            this.release();
            this.pickSnapshot = null;
        }
    }

    refreshPickSnapshot() {
        if (!this.pickingEnabled || this.readbackPending) return;
        this.readbackPending = true;
        this.renderer.getThreeJSRenderer().getArrayBufferAsync(this.positionSettled.value)
            // Ignore a readback that lands after picking was disabled.
            .then(buffer => {
                if (this.pickingEnabled) this.pickSnapshot = new Float32Array(buffer);
            })
            .catch(() => {})
            .finally(() => { this.readbackPending = false; });
    }

    step() {
        this.uniforms.time.value += this.dt;
        const feedback = this.collisionFeedbackEnabled &&
            this.impulseReadbacks < MAX_IMPULSE_READBACKS;
        this.uniforms.feedback.value = feedback ? this.feedbackScale : 0;
        if (feedback) {
            // The CPU copy is never written, so this re-uploads zeros: a
            // cleared accumulator for this step.
            this.impulseData.value.needsUpdate = true;
        }
        this.renderer.getThreeJSRenderer().compute(this.frameNodes);
        if (feedback) {
            this.readBackImpulses();
        }
        this.refreshPickSnapshot();
    }

    // getArrayBufferAsync submits its GPU copy synchronously (before its first
    // await), so this captures exactly this step's impulses even though the
    // next step clears the buffer before the result arrives.
    readBackImpulses() {
        const slots = this.colliderSlots;
        const generation = this.feedbackGeneration;
        this.impulseReadbacks++;
        this.renderer.getThreeJSRenderer().getArrayBufferAsync(this.impulseData.value)
            .then(buffer => {
                if (generation !== this.feedbackGeneration) return;
                const data = new Int32Array(buffer);
                slots.forEach((shape, k) => {
                    if (!shape.rigidBody) return;
                    const base = k * IMPULSE_STRIDE;
                    const values = Array.from(data.subarray(base, base + 6), v => v / IMPULSE_SCALE);
                    if (values.every(v => v === 0)) return;
                    this.pendingImpulses.push({
                        rigidBody: shape.rigidBody,
                        impulse: values.slice(0, 3),
                        torque: values.slice(3, 6),
                    });
                });
            })
            .catch(() => {})
            .finally(() => { this.impulseReadbacks--; });
    }

    setCollisionFeedback(enabled) {
        super.setCollisionFeedback(enabled);
        if (!enabled) {
            this.feedbackGeneration++;
            this.pendingImpulses = [];
        }
    }

    takeColliderImpulses() {
        const impulses = this.pendingImpulses;
        this.pendingImpulses = [];
        return impulses;
    }

    // Returns the particle within one grid spacing of the ray that is nearest
    // the camera, as { index, point, distance } (distance along the ray), or null.
    pick(ray) {
        if (!this.pickingEnabled || !this.pickSnapshot) return null;
        const maxDistanceSq = this.options.spacing * this.options.spacing;
        const point = new THREE.Vector3();
        const toPoint = new THREE.Vector3();
        let best = null;
        for (let i = 0; i < this.particleCount; i++) {
            point.fromArray(this.pickSnapshot, i * 4);
            // NaN fails every comparison below, so without this a NaN particle
            // would always be "hit" and every click would grab the cloth.
            if (!Number.isFinite(point.x + point.y + point.z)) continue;
            const along = toPoint.copy(point).sub(ray.origin).dot(ray.direction);
            if (along < 0 || ray.distanceSqToPoint(point) > maxDistanceSq) continue;
            if (!best || along < best.distance) {
                best = { index: i, point: point.clone(), distance: along };
            }
        }
        return best;
    }

    // The grabbed particle is treated as pinned at the target (see invMassOf).
    grab(hit) {
        this.uniforms.grabIndex.value = hit.index;
        this.uniforms.grabTarget.value.copy(hit.point);
    }

    moveGrab(point) {
        this.uniforms.grabTarget.value.copy(point);
    }

    // The particle keeps the velocity it was dragged with, so it can be thrown.
    release() {
        this.uniforms.grabIndex.value = -1;
    }

    // direction/strength as one vector ([x, y, z], world units per second²
    // along the surface normal); gust is 0 for steady wind, ~1 for strong gusts.
    setWind(wind, gust = 0) {
        this.uniforms.wind.value.set(wind[0], wind[1], wind[2]);
        this.uniforms.gust.value = gust;
    }

    // shapes: [{ type: 'sphere' | 'box' | 'capsule', position: [x, y, z],
    //   rotation: [x, y, z, w], radius, halfExtents: [x, y, z], halfHeight,
    //   linearVelocity: [x, y, z] }], in world space. Unknown types are skipped;
    // anything past MAX_COLLIDERS is ignored. Call before step() each frame.
    setColliders(shapes) {
        const data = this.colliderData.value.array;
        const planeData = this.hullPlanes.value.array;
        const slots = [];
        let count = 0;
        let planeCount = 0;
        for (const shape of shapes) {
            if (count >= MAX_COLLIDERS) break;
            const type = SHAPE_TYPES[shape.type];
            if (type === undefined) continue;
            let params;
            if (shape.type === 'convexHull') {
                const hullPlaneCount = shape.planes.length / 4;
                if (planeCount + hullPlaneCount > MAX_HULL_PLANES) {
                    if (!this.warnedHullPlanes) {
                        console.warn(`Cloth: convex hulls exceed ${MAX_HULL_PLANES} planes, skipping some`);
                        this.warnedHullPlanes = true;
                    }
                    continue;
                }
                planeData.set(shape.planes, planeCount * 4);
                params = [planeCount, hullPlaneCount, 0];
                planeCount += hullPlaneCount;
            } else {
                params = shape.type === 'box' ? shape.halfExtents
                    : shape.type === 'capsule' ? [shape.halfHeight, shape.radius, 0]
                    : [shape.radius, 0, 0];
            }
            const velocity = shape.linearVelocity ?? [0, 0, 0];
            data.set([
                ...shape.position, type,
                ...shape.rotation,
                ...params, 0,
                ...velocity, 0,
            ], count * COLLIDER_STRIDE * 4);
            slots.push(shape);
            count++;
        }
        // A new array (not mutated in place): in-flight readbacks keep the
        // slot list of the step they were taken for.
        this.colliderSlots = slots;
        this.uniforms.colliderCount.value = count;
        this.colliderData.value.needsUpdate = true;
        if (planeCount > 0) this.hullPlanes.value.needsUpdate = true;
    }

    // Compliance = 1/stiffness; 0 is rigid, larger is softer (see ClothOptions).
    setCompliance(stretch, bend) {
        const dtSq = this.dt * this.dt;
        this.uniforms.stretchAlphaTilde.value = stretch / dtSq;
        this.uniforms.bendAlphaTilde.value = bend / dtSq;
    }

    // Replaces the cloth's texture; null restores the default checkerboard.
    // The caller keeps ownership of textures it passes in: dispose() only frees
    // the default checkerboard, which is created on first use.
    setTexture(texture) {
        if (!texture && !this.defaultTexture) {
            this.defaultTexture = createCheckerTexture();
        }
        this.material.map = texture ?? this.defaultTexture;
        this.material.needsUpdate = true;
    }

    dispose() {
        this.geometry.dispose();
        this.material.dispose();
        this.defaultTexture?.dispose();
    }
}

export { ClothPatch, ClothOptions };
