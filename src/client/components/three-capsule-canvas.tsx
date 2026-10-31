import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type CapsuleColorVariant = 'blue' | 'red' | 'gold';

export interface ThreeCapsuleCanvasHandle {
  /** React再レンダリングを経由せずにスワイプ変位（px）を直接3Dループへ反映する */
  setDragOffset: (offsetX: number, offsetY: number) => void;
}

export interface ThreeCapsuleCanvasProps {
  /** カプセル切り替え（新規排出時の3D落下・バウンド演出トリガー）用の一意キー */
  capsuleKey?: string | null;
  capsuleColor: CapsuleColorVariant;
  crackProgress: number;
  interactionTrigger: number;
  /** 横スワイプ量（px）に応じた3D空間内の転がり・傾き制御 */
  dragOffsetX?: number;
  /** 縦スワイプ量（px）に応じた下方向リサイクル前傾制御 */
  dragOffsetY?: number;
  /** 長押しチャージ中の3Dバイブレーション＆内部発光制御 */
  isPressing?: boolean;
  /** モーダル・ドロワー表示中にWebGLフレームループを一時休止する省電力フラグ */
  isPaused?: boolean;
}

interface DropPhysicsState {
  active: boolean;
  y: number;
  vy: number;
  z: number;
  rollX: number;
  bounceCount: number;
}

interface ShardBaseTransform {
  mesh: THREE.Mesh;
  dirX: number;
  dirY: number;
  dirZ: number;
  baseRadius: number;
  baseY: number;
  rotY: number;
  rotZ: number;
}

const CAPSULE_PALETTE: Record<
  CapsuleColorVariant,
  {
    color: number;
    emissive: number;
    emissiveIntensity: number;
    metalness: number;
    roughness: number;
  }
> = {
  blue: {
    color: 0x0099ff,
    emissive: 0x002b5e,
    emissiveIntensity: 0.14,
    metalness: 0.12,
    roughness: 0.12,
  },
  red: {
    color: 0xff2e3b,
    emissive: 0x5c060c,
    emissiveIntensity: 0.16,
    metalness: 0.12,
    roughness: 0.12,
  },
  gold: {
    color: 0xffbe0b,
    emissive: 0x6e4200,
    emissiveIntensity: 0.24,
    metalness: 0.82,
    roughness: 0.14,
  },
};

function canCreateWebGLContext(canvas: HTMLCanvasElement): boolean {
  try {
    const gl =
      canvas.getContext('webgl2', { alpha: true, antialias: true }) ||
      canvas.getContext('webgl', { alpha: true, antialias: true });
    return Boolean(gl);
  } catch {
    return false;
  }
}

function isReducedMotionPreferred(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function createInitialDropState(reducedMotion: boolean): DropPhysicsState {
  if (reducedMotion) {
    return {
      active: false,
      y: 0,
      vy: 0,
      z: 0,
      rollX: 0,
      bounceCount: 2,
    };
  }
  return {
    active: true,
    y: 1.85,
    vy: -1.4,
    z: -0.58,
    rollX: -2.35,
    bounceCount: 0,
  };
}

export const ThreeCapsuleCanvas = React.forwardRef<
  ThreeCapsuleCanvasHandle,
  ThreeCapsuleCanvasProps
>(
  (
    {
      capsuleKey = null,
      capsuleColor,
      crackProgress,
      interactionTrigger,
      dragOffsetX = 0,
      dragOffsetY = 0,
      isPressing = false,
      isPaused = false,
    },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [contextEpoch, setContextEpoch] = useState<number>(0);

    const topMaterialRef = useRef<THREE.MeshPhysicalMaterial | null>(null);
    const shellShardMaterialRef = useRef<THREE.MeshPhysicalMaterial | null>(null);
    const impulseRef = useRef<{ wobble: number; spinBoost: number; squash: number; burst: number }>(
      {
        wobble: 0,
        spinBoost: 0,
        squash: 0,
        burst: 0,
      },
    );
    const dropPhysicsRef = useRef<DropPhysicsState>(
      createInitialDropState(isReducedMotionPreferred()),
    );
    const prevCapsuleKeyRef = useRef<string | null | undefined>(undefined);

    const initialColorRef = useRef<CapsuleColorVariant>(capsuleColor);
    const crackProgressRef = useRef<number>(crackProgress);
    const dragOffsetRef = useRef<{ x: number; y: number }>({ x: dragOffsetX, y: dragOffsetY });
    const isPressingRef = useRef<boolean>(isPressing);
    const isPausedRef = useRef<boolean>(isPaused);
    const wakeLoopRef = useRef<(() => void) | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        setDragOffset: (offsetX: number, offsetY: number) => {
          dragOffsetRef.current.x = offsetX;
          dragOffsetRef.current.y = offsetY;
          wakeLoopRef.current?.();
        },
      }),
      [],
    );

    useEffect(() => {
      dragOffsetRef.current.x = dragOffsetX;
      dragOffsetRef.current.y = dragOffsetY;
    }, [dragOffsetX, dragOffsetY]);

    useEffect(() => {
      isPressingRef.current = isPressing;
    }, [isPressing]);

    useEffect(() => {
      isPausedRef.current = isPaused;
      if (!isPaused) {
        wakeLoopRef.current?.();
      }
    }, [isPaused]);

    // 新しいカプセルが排出された際（capsuleKey 変化時）に3D落下＆バウンド物理を再トリガー
    useEffect(() => {
      if (prevCapsuleKeyRef.current === undefined) {
        prevCapsuleKeyRef.current = capsuleKey;
        return;
      }
      if (prevCapsuleKeyRef.current !== capsuleKey && capsuleKey !== null) {
        prevCapsuleKeyRef.current = capsuleKey;
        const reduced = isReducedMotionPreferred();
        dropPhysicsRef.current = createInitialDropState(reduced);
        impulseRef.current.burst = 0;
        impulseRef.current.spinBoost = reduced ? 0 : 0.42;
        impulseRef.current.wobble = reduced ? 0 : 0.18;
        wakeLoopRef.current?.();
      } else {
        prevCapsuleKeyRef.current = capsuleKey;
      }
    }, [capsuleKey]);

    useEffect(() => {
      const reduced = isReducedMotionPreferred();
      crackProgressRef.current = crackProgress;
      if (!reduced) {
        impulseRef.current.wobble = 0.46 + crackProgress * 0.24;
        impulseRef.current.squash = crackProgress >= 3 ? 0.34 : 0.24;
        impulseRef.current.spinBoost = crackProgress >= 3 ? 0.45 : 0.2;
      }
      if (crackProgress === 0) {
        impulseRef.current.burst = 0;
      }
      wakeLoopRef.current?.();
    }, [crackProgress, interactionTrigger]);

    useEffect(() => {
      initialColorRef.current = capsuleColor;
      const palette = CAPSULE_PALETTE[capsuleColor];
      const mat = topMaterialRef.current;
      if (mat) {
        mat.color.setHex(palette.color);
        mat.emissive.setHex(palette.emissive);
        mat.emissiveIntensity = palette.emissiveIntensity;
        mat.metalness = palette.metalness;
        mat.roughness = palette.roughness;
        mat.needsUpdate = true;
      }
      const shardMat = shellShardMaterialRef.current;
      if (shardMat) {
        shardMat.color.setHex(palette.color);
        shardMat.emissive.setHex(palette.emissive);
        shardMat.needsUpdate = true;
      }

      if (!isReducedMotionPreferred()) {
        impulseRef.current.spinBoost = 0.34;
        impulseRef.current.squash = 0.2;
      }
      wakeLoopRef.current?.();
    }, [capsuleColor]);

    useEffect(() => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas || !canCreateWebGLContext(canvas)) {
        return;
      }

      THREE.ColorManagement.enabled = true;

      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
          powerPreference: 'high-performance',
        });
      } catch {
        return;
      }

      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.18;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      const width = container.clientWidth || 256;
      const height = container.clientHeight || 256;
      renderer.setSize(width, height, false);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 50);
      camera.position.set(0, 0.28, 4.95);
      camera.lookAt(0, -0.04, 0);

      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      const roomEnv = new RoomEnvironment();
      const envTarget = pmremGenerator.fromScene(roomEnv, 0.04);
      scene.environment = envTarget.texture;
      roomEnv.dispose();
      pmremGenerator.dispose();

      const ambientLight = new THREE.AmbientLight(0xfff8eb, 0.88);
      scene.add(ambientLight);

      const keyLight = new THREE.DirectionalLight(0xffffff, 2.35);
      keyLight.position.set(3.5, 5.6, 4.6);
      scene.add(keyLight);

      const rimLight = new THREE.DirectionalLight(0x90e0ef, 1.45);
      rimLight.position.set(-4.0, 2.6, -3.0);
      scene.add(rimLight);

      const bounceLight = new THREE.DirectionalLight(0xffbe0b, 0.95);
      bounceLight.position.set(0, -4.0, 2.2);
      scene.add(bounceLight);

      const innerLight = new THREE.PointLight(0xffd166, 0.9, 5.5);
      innerLight.position.set(0, 0.05, 0);

      const rootGroup = new THREE.Group();
      rootGroup.rotation.x = 0.16;
      rootGroup.rotation.z = -0.08;
      scene.add(rootGroup);
      rootGroup.add(innerLight);

      const geometriesToDispose: THREE.BufferGeometry[] = [];
      const materialsToDispose: THREE.Material[] = [];

      // 1. 上半球（カラーのABS樹脂ドーム＋フランジリム＋空気穴）
      const topDomeGroup = new THREE.Group();
      rootGroup.add(topDomeGroup);

      const initialPalette = CAPSULE_PALETTE[initialColorRef.current];
      const topMaterial = new THREE.MeshPhysicalMaterial({
        color: initialPalette.color,
        emissive: initialPalette.emissive,
        emissiveIntensity: initialPalette.emissiveIntensity,
        metalness: initialPalette.metalness,
        roughness: initialPalette.roughness,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        reflectivity: 1.0,
        side: THREE.DoubleSide,
      });
      topMaterialRef.current = topMaterial;
      materialsToDispose.push(topMaterial);

      const topSphereGeo = new THREE.SphereGeometry(
        1.18,
        40,
        24,
        0,
        Math.PI * 2,
        0,
        Math.PI * 0.492,
      );
      geometriesToDispose.push(topSphereGeo);
      const topSphereMesh = new THREE.Mesh(topSphereGeo, topMaterial);
      topDomeGroup.add(topSphereMesh);

      const topLipGeo = new THREE.TorusGeometry(1.175, 0.056, 18, 48);
      geometriesToDispose.push(topLipGeo);
      const topLipMesh = new THREE.Mesh(topLipGeo, topMaterial);
      topLipMesh.rotation.x = Math.PI / 2;
      topLipMesh.position.y = 0.03;
      topDomeGroup.add(topLipMesh);

      // 頂部の成形リング＆空気穴ディテール
      const topMoldRingGeo = new THREE.TorusGeometry(0.28, 0.016, 10, 32);
      geometriesToDispose.push(topMoldRingGeo);
      const topMoldRingMesh = new THREE.Mesh(topMoldRingGeo, topMaterial);
      topMoldRingMesh.rotation.x = Math.PI / 2;
      topMoldRingMesh.position.y = 1.145;
      topDomeGroup.add(topMoldRingMesh);

      const ventHoleMat = new THREE.MeshStandardMaterial({
        color: 0x1e1b18,
        roughness: 0.9,
      });
      materialsToDispose.push(ventHoleMat);
      const ventHoleGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.06, 12);
      geometriesToDispose.push(ventHoleGeo);

      for (let i = 0; i < 4; i++) {
        const angle = (i * Math.PI) / 2 + Math.PI / 4;
        const hole = new THREE.Mesh(ventHoleGeo, ventHoleMat);
        hole.position.set(Math.cos(angle) * 0.44, 1.08, Math.sin(angle) * 0.44);
        hole.lookAt(0, 0, 0);
        hole.rotateX(Math.PI / 2);
        topDomeGroup.add(hole);
      }

      // 2. 下半球（半透明フロストPP樹脂＋インナー噛み合わせリム）
      const bottomDomeGroup = new THREE.Group();
      rootGroup.add(bottomDomeGroup);

      const bottomMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xfffdf7,
        roughness: 0.15,
        metalness: 0.02,
        ior: 1.46,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        reflectivity: 1.0,
        transparent: true,
        opacity: 0.78,
        side: THREE.DoubleSide,
      });
      materialsToDispose.push(bottomMaterial);

      const bottomSphereGeo = new THREE.SphereGeometry(
        1.155,
        40,
        24,
        0,
        Math.PI * 2,
        Math.PI * 0.508,
        Math.PI * 0.492,
      );
      geometriesToDispose.push(bottomSphereGeo);
      const bottomSphereMesh = new THREE.Mesh(bottomSphereGeo, bottomMaterial);
      bottomDomeGroup.add(bottomSphereMesh);

      const bottomLipGeo = new THREE.TorusGeometry(1.155, 0.045, 16, 48);
      geometriesToDispose.push(bottomLipGeo);
      const bottomLipMesh = new THREE.Mesh(bottomLipGeo, bottomMaterial);
      bottomLipMesh.rotation.x = Math.PI / 2;
      bottomLipMesh.position.y = -0.03;
      bottomDomeGroup.add(bottomLipMesh);

      const innerCollarGeo = new THREE.CylinderGeometry(1.11, 1.11, 0.22, 36, 1, true);
      geometriesToDispose.push(innerCollarGeo);
      const innerCollarMesh = new THREE.Mesh(innerCollarGeo, bottomMaterial);
      innerCollarMesh.position.y = 0.04;
      bottomDomeGroup.add(innerCollarMesh);

      // 3. カプセル内部の景品（記念メダル＆ミニブック）シルエット
      const prizeGroup = new THREE.Group();
      prizeGroup.position.y = -0.18;
      bottomDomeGroup.add(prizeGroup);

      const medalMat = new THREE.MeshPhysicalMaterial({
        color: 0xffd166,
        emissive: 0xb45309,
        emissiveIntensity: 0.28,
        metalness: 0.92,
        roughness: 0.16,
        clearcoat: 1.0,
      });
      materialsToDispose.push(medalMat);

      const medalDiscGeo = new THREE.CylinderGeometry(0.54, 0.54, 0.1, 32);
      geometriesToDispose.push(medalDiscGeo);
      const medalDisc = new THREE.Mesh(medalDiscGeo, medalMat);
      medalDisc.rotation.x = Math.PI * 0.32;
      medalDisc.rotation.z = -0.25;
      prizeGroup.add(medalDisc);

      const medalRimGeo = new THREE.TorusGeometry(0.46, 0.045, 12, 32);
      geometriesToDispose.push(medalRimGeo);
      const medalRim = new THREE.Mesh(medalRimGeo, medalMat);
      medalRim.rotation.x = Math.PI / 2;
      medalDisc.add(medalRim);

      const leafletMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        roughness: 0.4,
      });
      materialsToDispose.push(leafletMat);
      const leafletGeo = new THREE.BoxGeometry(0.78, 0.1, 0.52);
      geometriesToDispose.push(leafletGeo);
      const leafletMesh = new THREE.Mesh(leafletGeo, leafletMat);
      leafletMesh.position.set(0.08, -0.24, -0.1);
      leafletMesh.rotation.set(0.2, 0.4, -0.15);
      prizeGroup.add(leafletMesh);

      // 4. 3Dクラック発光リング＆立体シャード（ヒビ割れ進行・Stage 3開封時に放射飛散バースト）
      const crackRingGroup = new THREE.Group();
      rootGroup.add(crackRingGroup);

      const crackGlowMat = new THREE.MeshPhysicalMaterial({
        color: 0xfffbeb,
        emissive: 0xffbe0b,
        emissiveIntensity: 1.65,
        roughness: 0.1,
        metalness: 0.2,
      });
      materialsToDispose.push(crackGlowMat);

      const shellShardMat = new THREE.MeshPhysicalMaterial({
        color: initialPalette.color,
        emissive: initialPalette.emissive,
        emissiveIntensity: 0.45,
        roughness: 0.14,
        metalness: 0.25,
        clearcoat: 1.0,
      });
      shellShardMaterialRef.current = shellShardMat;
      materialsToDispose.push(shellShardMat);

      const seamGlowRingGeo = new THREE.TorusGeometry(1.16, 0.03, 14, 48);
      geometriesToDispose.push(seamGlowRingGeo);
      const seamGlowRing = new THREE.Mesh(seamGlowRingGeo, crackGlowMat);
      seamGlowRing.rotation.x = Math.PI / 2;
      crackRingGroup.add(seamGlowRing);

      const crackShardGeo = new THREE.OctahedronGeometry(0.115, 0);
      geometriesToDispose.push(crackShardGeo);

      const shardEntries: ShardBaseTransform[] = [];
      const shardCount = 12;
      for (let i = 0; i < shardCount; i++) {
        const angle = (i * Math.PI * 2) / shardCount;
        const isShellPiece = i % 3 === 0;
        const shard = new THREE.Mesh(crackShardGeo, isShellPiece ? shellShardMat : crackGlowMat);
        const dirX = Math.cos(angle);
        const dirZ = Math.sin(angle);
        const dirY = (i % 2 === 0 ? 1 : -1) * (0.28 + (i % 3) * 0.14);
        const baseY = (i % 2 === 0 ? 1 : -1) * 0.045;
        const rotY = -angle;
        const rotZ = (i % 2 === 0 ? 1 : -1) * 0.38;

        shard.position.set(dirX * 1.21, baseY, dirZ * 1.21);
        shard.scale.set(isShellPiece ? 1.35 : 1.75, 0.5, 0.5);
        shard.rotation.y = rotY;
        shard.rotation.z = rotZ;
        crackRingGroup.add(shard);

        shardEntries.push({
          mesh: shard,
          dirX,
          dirY,
          dirZ,
          baseRadius: 1.21,
          baseY,
          rotY,
          rotZ,
        });
      }

      // 5. ドーム底面の接地ドロップシャドウ
      const shadowCanvas = document.createElement('canvas');
      shadowCanvas.width = 128;
      shadowCanvas.height = 128;
      const ctx = shadowCanvas.getContext('2d');
      if (ctx) {
        const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 46);
        grad.addColorStop(0, 'rgba(30, 27, 24, 0.38)');
        grad.addColorStop(0.55, 'rgba(30, 27, 24, 0.14)');
        grad.addColorStop(1, 'rgba(30, 27, 24, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 128, 128);
      }
      const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
      shadowTexture.flipY = false;
      const shadowMat = new THREE.MeshBasicMaterial({
        map: shadowTexture,
        transparent: true,
        depthWrite: false,
      });
      materialsToDispose.push(shadowMat);
      const shadowGeo = new THREE.PlaneGeometry(2.25, 2.25);
      geometriesToDispose.push(shadowGeo);
      const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
      shadowMesh.rotation.x = -Math.PI / 2;
      shadowMesh.position.y = -1.28;
      scene.add(shadowMesh);

      const prefersReducedMotion = isReducedMotionPreferred();

      let animationFrameId = 0;
      let isContextLost = false;
      let isDisposed = false;
      const startTimeMs = performance.now();
      let lastFrameMs = startTimeMs;

      const shouldPauseLoop = (): boolean => {
        if (isDisposed || isContextLost) return true;
        if (isPausedRef.current) return true;
        if (typeof document !== 'undefined' && document.hidden) return true;
        return false;
      };

      const renderFrame = (nowMs: number) => {
        animationFrameId = 0;
        if (shouldPauseLoop()) {
          return;
        }

        const dt = Math.min(Math.max((nowMs - lastFrameMs) * 0.001, 0.001), 0.05);
        lastFrameMs = nowMs;
        const elapsed = (nowMs - startTimeMs) * 0.001;

        const progress = crackProgressRef.current;
        const dragX = dragOffsetRef.current.x;
        const dragY = dragOffsetRef.current.y;
        const pressing = isPressingRef.current;
        const imp = impulseRef.current;
        const drop = dropPhysicsRef.current;

        // フレームレート非依存の減衰
        imp.wobble *= Math.exp(-6.5 * dt);
        imp.spinBoost *= Math.exp(-5.0 * dt);
        imp.squash *= Math.exp(-9.0 * dt);

        // 1. 新規カプセル排出時の3D重力落下＆2バウンドスプリング物理
        let dropOffsetY = 0;
        let dropOffsetZ = 0;
        let dropRollX = 0;
        if (drop.active && !prefersReducedMotion) {
          const GRAVITY = 26.5;
          drop.vy -= GRAVITY * dt;
          drop.y += drop.vy * dt;

          if (drop.y <= 0) {
            drop.y = 0;
            const impactSpeed = Math.abs(drop.vy);
            if (drop.bounceCount < 2 && impactSpeed > 0.75) {
              const restitution = drop.bounceCount === 0 ? 0.42 : 0.22;
              drop.vy = impactSpeed * restitution;
              imp.squash = Math.max(imp.squash, Math.min(0.32, impactSpeed * 0.04));
              imp.wobble = Math.max(imp.wobble, Math.min(0.26, impactSpeed * 0.022));
              drop.bounceCount += 1;
            } else {
              drop.vy = 0;
              drop.active = false;
            }
          }

          const settleLerp = 1 - Math.exp(-8.5 * dt);
          drop.z += (0 - drop.z) * settleLerp;
          drop.rollX += (0 - drop.rollX) * settleLerp;

          dropOffsetY = drop.y;
          dropOffsetZ = drop.z;
          dropRollX = drop.rollX;
        }

        // 2. スワイプ量（横・下）に応じた3D空間移動と立体ロール回転
        const smoothLerp = 1 - Math.exp(-18 * dt);
        const targetPosX = (dragX / 130) * 0.62;
        const clampedDownY = Math.max(-45, Math.min(130, dragY));
        const targetDragPosY = -(clampedDownY / 130) * 0.42;

        rootGroup.position.x += (targetPosX - rootGroup.position.x) * smoothLerp;
        rootGroup.position.z = dropOffsetZ;

        // 長押しチャージ中の3Dバイブレーション
        const pressJitter = !prefersReducedMotion && pressing ? Math.sin(elapsed * 56) * 0.058 : 0;

        if (!prefersReducedMotion) {
          const dragSpin = (dragX / 130) * 2.4;
          rootGroup.rotation.y +=
            (0.72 + imp.spinBoost * 16 + dragSpin + (pressing ? 2.1 : 0)) * dt;
          const idleFloatY = drop.active ? 0 : Math.sin(elapsed * 2.6) * 0.068;
          rootGroup.position.y = dropOffsetY + idleFloatY + targetDragPosY;
        } else {
          rootGroup.position.y = targetDragPosY;
        }

        // 下スワイプ時は手前シュート方向へ前傾し、排出落下時は手前へ転がり出る
        const dragPitchX = (clampedDownY / 130) * 0.44;
        rootGroup.rotation.x = 0.16 + dropRollX + dragPitchX;

        const wobbleAngle = prefersReducedMotion ? 0 : Math.sin(elapsed * 28) * imp.wobble;
        const dragTiltZ = -(dragX / 130) * 0.36;
        rootGroup.rotation.z = -0.08 + wobbleAngle + dragTiltZ + pressJitter;

        // スクワッシュ＆下スワイプ吸引縮小＆長押しチャージ膨張
        const pressScaleBoost = pressing ? 0.045 : 0;
        const downShrink = clampedDownY > 10 ? Math.min(0.11, (clampedDownY - 10) / 850) : 0;
        const scaleY = (1 - imp.squash * 0.36 - pressScaleBoost) * (1 - downShrink);
        const scaleXZ = (1 + imp.squash * 0.23 + pressScaleBoost) * (1 - downShrink);
        rootGroup.scale.set(scaleXZ, scaleY, scaleXZ);

        // 3. ヒビ割れ進行（1〜2）と Stage 3（3/3 パカッ開封＆シャード放射バースト）
        const isStage3Open = progress >= 3;
        if (isStage3Open) {
          imp.burst = Math.min(1, imp.burst + dt * 5.2);
        } else {
          imp.burst *= Math.exp(-10 * dt);
        }

        const lidLerp = 1 - Math.exp((isStage3Open ? -16 : -12) * dt);
        const targetGap = isStage3Open ? 0.94 : progress * 0.15 + (pressing ? 0.065 : 0);
        const targetLidShiftX = isStage3Open ? -0.28 : 0;
        const targetLidRotZ = isStage3Open ? 0.68 : -progress * 0.1;
        const targetLidRotX = isStage3Open ? -0.34 : 0;

        topDomeGroup.position.y += (targetGap - topDomeGroup.position.y) * lidLerp;
        topDomeGroup.position.x += (targetLidShiftX - topDomeGroup.position.x) * lidLerp;
        topDomeGroup.rotation.z += (targetLidRotZ - topDomeGroup.rotation.z) * lidLerp;
        topDomeGroup.rotation.x += (targetLidRotX - topDomeGroup.rotation.x) * lidLerp;

        // Stage 3 開封瞬間は中の記念メダルがキラッと浮き上がってアピール
        const targetPrizeY = isStage3Open ? 0.14 : -0.18;
        prizeGroup.position.y += (targetPrizeY - prizeGroup.position.y) * lidLerp;
        prizeGroup.rotation.y = elapsed * (isStage3Open ? 5.2 : 1.8);

        innerLight.intensity = isStage3Open ? 6.2 : 0.95 + progress * 2.5 + (pressing ? 1.6 : 0);

        crackRingGroup.visible = progress > 0 || pressing;
        if (crackRingGroup.visible) {
          const burstAmt = imp.burst;
          const ringPulse =
            1 +
            burstAmt * 0.38 +
            (prefersReducedMotion
              ? 0
              : Math.sin(elapsed * 22) * 0.05 * Math.max(progress, pressing ? 1 : 0));
          seamGlowRing.scale.setScalar(ringPulse);
          seamGlowRing.visible = burstAmt < 0.85;
          crackRingGroup.rotation.y = -elapsed * (isStage3Open ? 3.2 : 1.4);

          for (let i = 0; i < shardEntries.length; i++) {
            const entry = shardEntries[i];
            const radialDist = entry.baseRadius + progress * 0.04 + burstAmt * 1.15;
            entry.mesh.position.set(
              entry.dirX * radialDist,
              entry.baseY + entry.dirY * burstAmt * 0.95,
              entry.dirZ * radialDist,
            );
            if (!prefersReducedMotion && burstAmt > 0.01) {
              entry.mesh.rotation.x = burstAmt * 4.2 * (i % 2 === 0 ? 1 : -1);
              entry.mesh.rotation.z = entry.rotZ + burstAmt * 3.1;
            } else {
              entry.mesh.rotation.x = 0;
              entry.mesh.rotation.z = entry.rotZ;
            }
          }
        }

        // 4. 接地シャドウ（落下高度に応じて自然に縮小・薄化）
        const shadowScale = Math.max(0.42, 1 - Math.max(0, rootGroup.position.y) * 0.28);
        shadowMesh.position.x = rootGroup.position.x * 0.85;
        shadowMesh.scale.set(shadowScale, shadowScale, 1);
        shadowMat.opacity = Math.max(0.25, 1 - Math.max(0, rootGroup.position.y) * 0.35);

        renderer.render(scene, camera);
        animationFrameId = window.requestAnimationFrame(renderFrame);
      };

      const ensureLoopRunning = () => {
        if (shouldPauseLoop()) {
          if (animationFrameId !== 0) {
            window.cancelAnimationFrame(animationFrameId);
            animationFrameId = 0;
          }
          return;
        }
        if (animationFrameId === 0) {
          lastFrameMs = performance.now();
          animationFrameId = window.requestAnimationFrame(renderFrame);
        }
      };

      wakeLoopRef.current = ensureLoopRunning;
      // 初回フレームを即時描画（モーダル復元時でも背景にカプセルが1フレーム描かれた状態にする）
      renderer.render(scene, camera);
      ensureLoopRunning();

      const handleVisibilityChange = () => {
        ensureLoopRunning();
      };
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', handleVisibilityChange);
      }

      const handleContextLost = (event: Event) => {
        event.preventDefault();
        isContextLost = true;
        if (animationFrameId !== 0) {
          window.cancelAnimationFrame(animationFrameId);
          animationFrameId = 0;
        }
      };

      const handleContextRestored = () => {
        isContextLost = false;
        setContextEpoch((prev) => prev + 1);
      };

      canvas.addEventListener('webglcontextlost', handleContextLost);
      canvas.addEventListener('webglcontextrestored', handleContextRestored);

      let resizeObserver: ResizeObserver | null = null;
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (!entry || isContextLost) return;
          const nextWidth = Math.max(entry.contentRect.width, 120);
          const nextHeight = Math.max(entry.contentRect.height, 120);
          camera.aspect = nextWidth / nextHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(nextWidth, nextHeight, false);
          if (shouldPauseLoop()) {
            renderer.render(scene, camera);
          }
        });
        resizeObserver.observe(container);
      }

      return () => {
        isDisposed = true;
        wakeLoopRef.current = null;
        if (animationFrameId !== 0) {
          window.cancelAnimationFrame(animationFrameId);
        }
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', handleVisibilityChange);
        }
        canvas.removeEventListener('webglcontextlost', handleContextLost);
        canvas.removeEventListener('webglcontextrestored', handleContextRestored);
        resizeObserver?.disconnect();
        envTarget.dispose();
        shadowTexture.dispose();
        geometriesToDispose.forEach((geo) => geo.dispose());
        materialsToDispose.forEach((mat) => mat.dispose());
        topMaterialRef.current = null;
        shellShardMaterialRef.current = null;
        renderer.dispose();
      };
    }, [contextEpoch]);

    return (
      <div
        ref={containerRef}
        data-testid="three-capsule-canvas"
        data-capsule-color={capsuleColor}
        data-paused={isPaused ? 'true' : 'false'}
        className="capsule-3d-viewport-size relative flex items-center justify-center pointer-events-none"
      >
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>
    );
  },
);

ThreeCapsuleCanvas.displayName = 'ThreeCapsuleCanvas';
