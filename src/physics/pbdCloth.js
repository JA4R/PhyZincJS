import Zinc from "zincjs";
const THREE = Zinc.THREE;
const {
    Fn, attributeArray, instanceIndex, uniform, vec3, vec4, float, int, select, sin, Loop
} = THREE.TSL;

// Maximum number of rigid colliders the cloth can collide against per step.
const MAX_COLLIDERS = 64;
// vec4 slots per collider in the collider buffer (see setColliders).
const COLLIDER_STRIDE = 4;
// Shape type codes, matching Rapier's ShapeType numbering.
const SHAPE_TYPES = { sphere: 0, box: 1, capsule: 2 };

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
const ClothOptions = function(gridWidth, gridHeight, spacing, origin,
    pin, gravity, damping, solverIterations, stretchCompliance, bendCompliance,
    colDirection, rowDirection, collisionThickness, friction) {
    return {
        gridWidth: gridWidth ?? 20,
        gridHeight: gridHeight ?? 20,
        spacing: spacing ?? 0.1,
        origin: origin ?? [0, 0, 0],
        pin: pin ?? 'topCorners',
        gravity: gravity ?? [0, 0, -9.81],
        damping: damping ?? 0.98,
        solverIterations: solverIterations ?? 20,
        // Compliance α = 1/stiffness (m/N, unit particle mass). 0 = rigid link;
        // larger = softer. Bending is much softer than stretch, like real fabric.
        stretchCompliance: stretchCompliance ?? 1e-5,
        bendCompliance: bendCompliance ?? 1e-3,
        colDirection: colDirection ?? [1, 0, 0],
        rowDirection: rowDirection ?? [0, 0, -1],
        // Distance particles are kept from collider surfaces.
        collisionThickness: collisionThickness ?? (spacing ?? 0.1) * 0.25,
        // 0 = frictionless sliding, 1 = cloth sticks to the surface it touches.
        friction: friction ?? 0.5
    };
}

// Grid position of particle (col, row), shared by the CPU placeholder geometry
// and the GPU init kernel so the two always agree.
const gridPoint = (origin, colDirection, rowDirection, spacing, col, row) => [0, 1, 2].map(axis =>
    origin[axis] + (colDirection[axis] * col + rowDirection[axis] * row) * spacing);

// Static placeholder geometry: topology and UVs only matter, since the
// material's positionNode reads the GPU buffer instead.
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
// Returns { dLambda, correction } nodes.
const xpbdConstraint = (i, selfPos, selfInvMass, readBuf, invMass, valid, neighborIndex,
    restLen, lambda, alphaTilde) => {
    const index = valid.select(neighborIndex, i);
    const neighborInvMass = invMass.element(index);
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
const localDistance = (local, type, params) => {
    const dSphere = local.length().sub(params.x);
    const q = local.abs().sub(params.xyz);
    const dBox = q.max(0.0).length().add(q.x.max(q.y).max(q.z).min(0.0));
    const axial = local.y.clamp(params.x.negate(), params.x);
    const dCapsule = vec3(local.x, local.y.sub(axial), local.z).length().sub(params.y);
    return select(type.lessThan(0.5), dSphere, select(type.lessThan(1.5), dBox, dCapsule));
}

async function createClothPatch(renderer, options) {
    const opts = ClothOptions(
        options?.gridWidth, options?.gridHeight, options?.spacing, options?.origin,
        options?.pin, options?.gravity, options?.damping, options?.solverIterations,
        options?.stretchCompliance, options?.bendCompliance, options?.colDirection,
        options?.rowDirection, options?.collisionThickness, options?.friction
    );
    const {
        gridWidth, gridHeight, spacing, origin, pin, gravity, damping, solverIterations,
        stretchCompliance, bendCompliance, colDirection, rowDirection, collisionThickness, friction
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
    // [shape params], [linear velocity, unused].
    const colliderData = attributeArray(MAX_COLLIDERS * COLLIDER_STRIDE, 'vec4');

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
    const colliderCountU = uniform(0, 'int');
    const thicknessU = uniform(collisionThickness, 'float');
    const frictionU = uniform(friction, 'float');

    // Distance and outward normal from world point p to collider k's surface.
    // The normal is the central-difference gradient of the local distance
    // field, rotated back to world space — one generic path for every shape.
    const colliderContact = (p, k) => {
        const base = k.mul(COLLIDER_STRIDE);
        const header = colliderData.element(base).toVar();
        const rotation = colliderData.element(base.add(1)).toVar();
        const params = colliderData.element(base.add(2)).toVar();
        const type = header.w;
        const inverseRotation = vec4(rotation.xyz.negate(), rotation.w);
        const local = rotateByQuaternion(inverseRotation, p.sub(header.xyz)).toVar();
        const h = 1e-4;
        const gradient = vec3(
            localDistance(local.add(vec3(h, 0, 0)), type, params)
                .sub(localDistance(local.sub(vec3(h, 0, 0)), type, params)),
            localDistance(local.add(vec3(0, h, 0)), type, params)
                .sub(localDistance(local.sub(vec3(0, h, 0)), type, params)),
            localDistance(local.add(vec3(0, 0, h)), type, params)
                .sub(localDistance(local.sub(vec3(0, 0, h)), type, params))
        );
        const normal = rotateByQuaternion(rotation, gradient.normalize());
        const distance = localDistance(local, type, params);
        const bodyVelocity = colliderData.element(base.add(3)).xyz;
        return { distance, normal, bodyVelocity };
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
        invMass.element(i).assign(select(pinned, float(0.0), float(1.0)));
    })().compute(particleCount);

    const predictKernel = Fn(() => {
        const i = instanceIndex.toInt();
        const col = i.mod(gridWidthU);
        const row = i.div(gridWidthU);
        const selfInvMass = invMass.element(i);
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
        const normal = tangentU.cross(tangentV).normalize();

        // Aerodynamic-style force: only the component of relative wind along the
        // normal pushes the cloth (air sliding along the surface does little),
        // and relative wind includes the particle's own velocity so a surface
        // already moving with the wind is pushed less. The gust term varies over
        // time and across the patch so it flutters instead of holding one bulge.
        const gust = sin(timeU.mul(2.3).add(col.toFloat().mul(0.35)).add(row.toFloat().mul(0.2)))
            .mul(0.5).add(0.5).mul(gustU).add(1.0);
        const relativeWind = windU.mul(gust).sub(vel);
        const windForce = normal.mul(normal.dot(relativeWind));

        vel.assign(vel.add(gravityU.add(windForce).mul(dtU).mul(selfInvMass)).mul(dampingU));
        velocity.element(i).assign(vel);
        // XPBD: λ accumulates over one timestep's iterations, reset every step.
        lambdaStructural.element(i).assign(vec4(0, 0, 0, 0));
        lambdaBending.element(i).assign(vec4(0, 0, 0, 0));
        positionScratchA.element(i).assign(positionSettled.element(i).add(vel.mul(dtU)));
    })().compute(particleCount);

    const buildSolveKernel = (readBuf, writeBuf) => Fn(() => {
        const i = instanceIndex.toInt();
        const col = i.mod(gridWidthU);
        const row = i.div(gridWidthU);
        const selfInvMass = invMass.element(i);
        const selfPos = readBuf.element(i).toVar();
        const structLambda = lambdaStructural.element(i).toVar();
        const bendLambda = lambdaBending.element(i).toVar();

        const solve = (valid, neighborIndex, restLen, lambda, alphaTilde) =>
            xpbdConstraint(i, selfPos, selfInvMass, readBuf, invMass, valid, neighborIndex,
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
        Loop({ start: int(0), end: colliderCountU, type: 'int', condition: '<' }, ({ i: k }) => {
            const contact = colliderContact(newPos, k);
            const penetration = thicknessU.sub(contact.distance).max(0.0);
            newPos.addAssign(contact.normal.mul(penetration).mul(movable));
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

        // Friction, applied once per step at velocity level: for particles in
        // contact, remove a fraction of the tangential velocity relative to the
        // touching body, so cloth grips (and is carried by) moving bodies.
        Loop({ start: int(0), end: colliderCountU, type: 'int', condition: '<' }, ({ i: k }) => {
            const contact = colliderContact(finalPos, k);
            const touching = select(contact.distance.lessThan(thicknessU.mul(1.05)),
                float(1.0), float(0.0));
            const relative = vel.sub(contact.bodyVelocity);
            const tangential = relative.sub(contact.normal.mul(relative.dot(contact.normal)));
            vel.subAssign(tangential.mul(frictionU).mul(touching));
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

    const geometry = buildGeometry(gridWidth, gridHeight, spacing, origin, colDirection, rowDirection);
    const material = new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color("rgb(200, 60, 60)"),
        side: THREE.DoubleSide
    });
    material.positionNode = positionSettled.toAttribute();
    const mesh = new THREE.Mesh(geometry, material);
    // The CPU bounding volume only reflects the placeholder geometry, not the
    // GPU-deformed surface, so culling against it can wrongly hide the cloth.
    mesh.frustumCulled = false;

    // Run once, before the mesh is registered or step() is ever called from the
    // render loop, so every particle buffer is fully seeded before any frame
    // compute reads from it.
    await renderer.getThreeJSRenderer().computeAsync(initKernel);

    const step = () => {
        timeU.value += dt;
        renderer.getThreeJSRenderer().compute(frameNodes);
    }

    // direction/strength as one vector ([x, y, z], world units per second²
    // along the surface normal); gust is 0 for steady wind, ~1 for strong gusts.
    const setWind = (wind, gust = 0) => {
        windU.value.set(wind[0], wind[1], wind[2]);
        gustU.value = gust;
    }

    // shapes: [{ type: 'sphere' | 'box' | 'capsule', position: [x, y, z],
    //   rotation: [x, y, z, w], radius, halfExtents: [x, y, z], halfHeight,
    //   linearVelocity: [x, y, z] }], in world space. Unknown types are skipped;
    // anything past MAX_COLLIDERS is ignored. Call before step() each frame.
    const setColliders = (shapes) => {
        const data = colliderData.value.array;
        let count = 0;
        for (const shape of shapes) {
            if (count >= MAX_COLLIDERS) break;
            const type = SHAPE_TYPES[shape.type];
            if (type === undefined) continue;
            const params = shape.type === 'box' ? shape.halfExtents
                : shape.type === 'capsule' ? [shape.halfHeight, shape.radius, 0]
                : [shape.radius, 0, 0];
            const velocity = shape.linearVelocity ?? [0, 0, 0];
            data.set([
                ...shape.position, type,
                ...shape.rotation,
                ...params, 0,
                ...velocity, 0,
            ], count * COLLIDER_STRIDE * 4);
            count++;
        }
        colliderCountU.value = count;
        colliderData.value.needsUpdate = true;
    }

    // Compliance = 1/stiffness; 0 is rigid, larger is softer (see ClothOptions).
    const setCompliance = (stretch, bend) => {
        stretchAlphaTildeU.value = stretch / (dt * dt);
        bendAlphaTildeU.value = bend / (dt * dt);
    }

    const dispose = () => {
        geometry.dispose();
        material.dispose();
    }

    return { mesh, step, setWind, setCompliance, setColliders, dispose };
}

export { createClothPatch, ClothOptions };
