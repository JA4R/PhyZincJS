import Zinc from "zincjs";
const THREE = Zinc.THREE;
const {
    Fn, attributeArray, instanceIndex, uniform, vec3, vec4, float, int, select, sin
} = THREE.TSL;

// Proof-of-concept WebGPU XPBD (extended Position-Based-Dynamics) cloth patch.
// Stretch/bend stiffness is set by compliance (inverse stiffness, α = 1/k), so
// it is a material property rather than an artefact of iteration count.
// Self-contained:
// no Rapier/PhyZinc physics dependency. Validates the GPU-resident
// compute-to-render pipeline (three.js TSL storage buffers feeding a node
// material's positionNode directly, zero CPU readback) before any future
// Rapier integration.
const ClothOptions = function(gridWidth, gridHeight, spacing, origin,
    fixedCorners, gravity, damping, solverIterations, stretchCompliance, bendCompliance) {
    return {
        gridWidth: gridWidth ?? 20,
        gridHeight: gridHeight ?? 20,
        spacing: spacing ?? 0.1,
        origin: origin ?? [0, 0, 0],
        fixedCorners: fixedCorners ?? true,
        gravity: gravity ?? [0, 0, -9.81],
        damping: damping ?? 0.98,
        solverIterations: solverIterations ?? 20,
        // Compliance α = 1/stiffness (m/N, unit particle mass). 0 = rigid link;
        // larger = softer. Bending is much softer than stretch, like real fabric.
        stretchCompliance: stretchCompliance ?? 1e-5,
        bendCompliance: bendCompliance ?? 1e-3
    };
}

// Grid spans X (col) and Z (row), row 0 at the top (highest Z), hanging down
// as row increases — a vertical curtain facing the camera on typical default
// viewing angles, rather than a horizontal patch lying flat in the ground
// plane (which is edge-on and effectively invisible from a level/3-quarter
// camera angle, since it's perfectly flat along the Z-up "vertical" axis).
const buildGeometry = (gridWidth, gridHeight, spacing, origin) => {
    const geometry = new THREE.BufferGeometry();
    const count = gridWidth * gridHeight;
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    for (let row = 0; row < gridHeight; row++) {
        for (let col = 0; col < gridWidth; col++) {
            const i = row * gridWidth + col;
            positions[i * 3 + 0] = origin[0] + col * spacing;
            positions[i * 3 + 1] = origin[1];
            positions[i * 3 + 2] = origin[2] - row * spacing;
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

async function createClothPatch(renderer, options) {
    const opts = ClothOptions(
        options?.gridWidth, options?.gridHeight, options?.spacing, options?.origin,
        options?.fixedCorners, options?.gravity, options?.damping, options?.solverIterations,
        options?.stretchCompliance, options?.bendCompliance
    );
    const {
        gridWidth, gridHeight, spacing, origin, fixedCorners, gravity, damping, solverIterations,
        stretchCompliance, bendCompliance
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

    const initKernel = Fn(() => {
        const i = instanceIndex.toInt();
        const col = i.mod(gridWidthU);
        const row = i.div(gridWidthU);

        const pos = vec3(
            float(origin[0]).add(col.toFloat().mul(restLengthU)),
            float(origin[1]),
            float(origin[2]).sub(row.toFloat().mul(restLengthU))
        );
        positionSettled.element(i).assign(pos);
        velocity.element(i).assign(vec3(0, 0, 0));
        lambdaStructural.element(i).assign(vec4(0, 0, 0, 0));
        lambdaBending.element(i).assign(vec4(0, 0, 0, 0));

        // Pin only the top-left/top-right corners (row 0) so the patch hangs
        // and drapes under gravity like a curtain/flag — a much more visually
        // obvious validation than a flat tablecloth sagging in the middle.
        const pinned = fixedCorners
            ? row.equal(0).and(col.equal(0).or(col.equal(gridWidthU.sub(1))))
            : col.equal(-1); // never true -> nothing pinned
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

        writeBuf.element(i).assign(selfPos.add(safeCorrection));
    })().compute(particleCount);

    const solveAtoB = buildSolveKernel(positionScratchA, positionScratchB);
    const solveBtoA = buildSolveKernel(positionScratchB, positionScratchA);

    const finaliseKernel = Fn(() => {
        const i = instanceIndex.toInt();
        const oldPos = positionSettled.element(i).toVar();
        const finalPos = positionScratchA.element(i).toVar();
        velocity.element(i).assign(finalPos.sub(oldPos).div(dtU));
        positionSettled.element(i).assign(finalPos);
    })().compute(particleCount);

    const frameNodes = [predictKernel];
    for (let n = 0; n < solverIterations; n++) {
        frameNodes.push(n % 2 === 0 ? solveAtoB : solveBtoA);
    }
    // solverIterations must be even (default 20) so the last solve pass always
    // writes into positionScratchA, matching finaliseKernel's read above.
    frameNodes.push(finaliseKernel);

    const geometry = buildGeometry(gridWidth, gridHeight, spacing, origin);
    const material = new THREE.MeshBasicNodeMaterial({
        color: new THREE.Color("rgb(200, 60, 60)"),
        side: THREE.DoubleSide
    });
    material.positionNode = positionSettled.toAttribute();
    const mesh = new THREE.Mesh(geometry, material);

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

    // Compliance = 1/stiffness; 0 is rigid, larger is softer (see ClothOptions).
    const setCompliance = (stretch, bend) => {
        stretchAlphaTildeU.value = stretch / (dt * dt);
        bendAlphaTildeU.value = bend / (dt * dt);
    }

    const dispose = () => {
        geometry.dispose();
        material.dispose();
    }

    return { mesh, step, setWind, setCompliance, dispose };
}

export { createClothPatch, ClothOptions };
