import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type CapsuleColorVariant = 'blue' | 'red' | 'gold';

export interface ThreeCapsuleCanvasProps {
  capsuleColor: CapsuleColorVariant;
  crackProgress: number;
  interactionTrigger: number;
  /** 横スワイプ量（px）に応じた3D空間内の転がり・傾き制御 */
  dragOffsetX?: number;
  /** 長押しチャージ中の3Dバイブレーション＆内部発光制御 */
  isPressing?: boolean;
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
    emissiveIntensity: 0.12,
    metalness: 0.1,
    roughness: 0.14,
  },
  red: {
    color: 0xff2e3b,
    emissive: 0x5c060c,
    emissiveIntensity: 0.14,
    metalness: 0.1,
    roughness: 0.14,
  },
  gold: {
    color: 0xffbe0b,
    emissive: 0x6e4200,
    emissiveIntensity: 0.22,
    metalness: 0.78,
    roughness: 0.16,
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

export const ThreeCapsuleCanvas: React.FC<ThreeCapsuleCanvasProps> = ({
  capsuleColor,
  crackProgress,
  interactionTrigger,
  dragOffsetX = 0,
  isPressing = false,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const topMaterialRef = useRef<THREE.MeshPhysicalMaterial | null>(null);
  const topDomeGroupRef = useRef<THREE.Group | null>(null);
  const bottomDomeGroupRef = useRef<THREE.Group | null>(null);
  const crackRingGroupRef = useRef<THREE.Group | null>(null);
  const innerLightRef = useRef<THREE.PointLight | null>(null);
  const impulseRef = useRef<{ wobble: number; spinBoost: number; squash: number }>({
    wobble: 0,
    spinBoost: 0,
    squash: 0,
  });
  const initialColorRef = useRef<CapsuleColorVariant>(capsuleColor);
  const crackProgressRef = useRef<number>(crackProgress);
  const dragOffsetXRef = useRef<number>(dragOffsetX);
  const isPressingRef = useRef<boolean>(isPressing);

  useEffect(() => {
    dragOffsetXRef.current = dragOffsetX;
  }, [dragOffsetX]);

  useEffect(() => {
    isPressingRef.current = isPressing;
  }, [isPressing]);

  useEffect(() => {
    crackProgressRef.current = crackProgress;
    impulseRef.current.wobble = 0.45 + crackProgress * 0.22;
    impulseRef.current.squash = 0.24;
    impulseRef.current.spinBoost = 0.18;
  }, [crackProgress, interactionTrigger]);

  useEffect(() => {
    const mat = topMaterialRef.current;
    if (!mat) return;
    const palette = CAPSULE_PALETTE[capsuleColor];
    mat.color.setHex(palette.color);
    mat.emissive.setHex(palette.emissive);
    mat.emissiveIntensity = palette.emissiveIntensity;
    mat.metalness = palette.metalness;
    mat.roughness = palette.roughness;
    mat.needsUpdate = true;

    impulseRef.current.spinBoost = 0.34;
    impulseRef.current.squash = 0.2;
  }, [capsuleColor]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas || !canCreateWebGLContext(canvas)) {
      return;
    }

    THREE.ColorManagement.enabled = true;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const width = container.clientWidth || 256;
    const height = container.clientHeight || 256;
    renderer.setSize(width, height, false);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 50);
    camera.position.set(0, 0.28, 4.85);
    camera.lookAt(0, -0.05, 0);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    const envTarget = pmremGenerator.fromScene(roomEnv, 0.04);
    scene.environment = envTarget.texture;
    roomEnv.dispose();
    pmremGenerator.dispose();

    const ambientLight = new THREE.AmbientLight(0xfff8eb, 0.85);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(3.5, 5.5, 4.5);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x90e0ef, 1.35);
    rimLight.position.set(-4.0, 2.5, -3.0);
    scene.add(rimLight);

    const bounceLight = new THREE.DirectionalLight(0xffbe0b, 0.9);
    bounceLight.position.set(0, -4.0, 2.0);
    scene.add(bounceLight);

    const innerLight = new THREE.PointLight(0xffd166, 0.9, 5.0);
    innerLight.position.set(0, 0.05, 0);
    innerLightRef.current = innerLight;

    const rootGroup = new THREE.Group();
    rootGroup.rotation.x = 0.16;
    rootGroup.rotation.z = -0.08;
    scene.add(rootGroup);
    rootGroup.add(innerLight);

    const geographiesToDispose: THREE.BufferGeometry[] = [];
    const materialsToDispose: THREE.Material[] = [];

    // 1. 上半球（カラーのABS樹脂ドーム＋フランジリム＋空気穴）
    const topDomeGroup = new THREE.Group();
    topDomeGroupRef.current = topDomeGroup;
    rootGroup.add(topDomeGroup);

    const initialPalette = CAPSULE_PALETTE[initialColorRef.current];
    const topMaterial = new THREE.MeshPhysicalMaterial({
      color: initialPalette.color,
      emissive: initialPalette.emissive,
      emissiveIntensity: initialPalette.emissiveIntensity,
      metalness: initialPalette.metalness,
      roughness: initialPalette.roughness,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
      reflectivity: 1.0,
      side: THREE.DoubleSide,
    });
    topMaterialRef.current = topMaterial;
    materialsToDispose.push(topMaterial);

    const topSphereGeo = new THREE.SphereGeometry(1.18, 64, 32, 0, Math.PI * 2, 0, Math.PI * 0.492);
    geographiesToDispose.push(topSphereGeo);
    const topSphereMesh = new THREE.Mesh(topSphereGeo, topMaterial);
    topDomeGroup.add(topSphereMesh);

    const topLipGeo = new THREE.TorusGeometry(1.175, 0.055, 24, 64);
    geographiesToDispose.push(topLipGeo);
    const topLipMesh = new THREE.Mesh(topLipGeo, topMaterial);
    topLipMesh.rotation.x = Math.PI / 2;
    topLipMesh.position.y = 0.03;
    topDomeGroup.add(topLipMesh);

    // 頂部の成形リング＆空気穴ディテール
    const topMoldRingGeo = new THREE.TorusGeometry(0.28, 0.016, 12, 36);
    geographiesToDispose.push(topMoldRingGeo);
    const topMoldRingMesh = new THREE.Mesh(topMoldRingGeo, topMaterial);
    topMoldRingMesh.rotation.x = Math.PI / 2;
    topMoldRingMesh.position.y = 1.145;
    topDomeGroup.add(topMoldRingMesh);

    const ventHoleMat = new THREE.MeshStandardMaterial({
      color: 0x1e1b18,
      roughness: 0.9,
    });
    materialsToDispose.push(ventHoleMat);
    const ventHoleGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.06, 16);
    geographiesToDispose.push(ventHoleGeo);

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
    bottomDomeGroupRef.current = bottomDomeGroup;
    rootGroup.add(bottomDomeGroup);

    const bottomMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xfffdf7,
      roughness: 0.16,
      metalness: 0.02,
      ior: 1.46,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
      reflectivity: 1.0,
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
    });
    materialsToDispose.push(bottomMaterial);

    const bottomSphereGeo = new THREE.SphereGeometry(
      1.155,
      64,
      32,
      0,
      Math.PI * 2,
      Math.PI * 0.508,
      Math.PI * 0.492,
    );
    geographiesToDispose.push(bottomSphereGeo);
    const bottomSphereMesh = new THREE.Mesh(bottomSphereGeo, bottomMaterial);
    bottomDomeGroup.add(bottomSphereMesh);

    const bottomLipGeo = new THREE.TorusGeometry(1.155, 0.045, 20, 64);
    geographiesToDispose.push(bottomLipGeo);
    const bottomLipMesh = new THREE.Mesh(bottomLipGeo, bottomMaterial);
    bottomLipMesh.rotation.x = Math.PI / 2;
    bottomLipMesh.position.y = -0.03;
    bottomDomeGroup.add(bottomLipMesh);

    const innerCollarGeo = new THREE.CylinderGeometry(1.11, 1.11, 0.22, 48, 1, true);
    geographiesToDispose.push(innerCollarGeo);
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
      emissiveIntensity: 0.25,
      metalness: 0.9,
      roughness: 0.18,
      clearcoat: 1.0,
    });
    materialsToDispose.push(medalMat);

    const medalDiscGeo = new THREE.CylinderGeometry(0.54, 0.54, 0.1, 40);
    geographiesToDispose.push(medalDiscGeo);
    const medalDisc = new THREE.Mesh(medalDiscGeo, medalMat);
    medalDisc.rotation.x = Math.PI * 0.32;
    medalDisc.rotation.z = -0.25;
    prizeGroup.add(medalDisc);

    const medalRimGeo = new THREE.TorusGeometry(0.46, 0.045, 16, 40);
    geographiesToDispose.push(medalRimGeo);
    const medalRim = new THREE.Mesh(medalRimGeo, medalMat);
    medalRim.rotation.x = Math.PI / 2;
    medalDisc.add(medalRim);

    const leafletMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      roughness: 0.4,
    });
    materialsToDispose.push(leafletMat);
    const leafletGeo = new THREE.BoxGeometry(0.78, 0.1, 0.52);
    geographiesToDispose.push(leafletGeo);
    const leafletMesh = new THREE.Mesh(leafletGeo, leafletMat);
    leafletMesh.position.set(0.08, -0.24, -0.1);
    leafletMesh.rotation.set(0.2, 0.4, -0.15);
    prizeGroup.add(leafletMesh);

    // 4. 3Dクラック発光リング＆立体稲妻シャード（ヒビ割れ進行・長押しチャージ時に3D空間で出現）
    const crackRingGroup = new THREE.Group();
    crackRingGroupRef.current = crackRingGroup;
    rootGroup.add(crackRingGroup);

    const crackGlowMat = new THREE.MeshPhysicalMaterial({
      color: 0xfff3b0,
      emissive: 0xffbe0b,
      emissiveIntensity: 1.4,
      roughness: 0.1,
      metalness: 0.2,
    });
    materialsToDispose.push(crackGlowMat);

    const seamGlowRingGeo = new THREE.TorusGeometry(1.16, 0.028, 16, 64);
    geographiesToDispose.push(seamGlowRingGeo);
    const seamGlowRing = new THREE.Mesh(seamGlowRingGeo, crackGlowMat);
    seamGlowRing.rotation.x = Math.PI / 2;
    crackRingGroup.add(seamGlowRing);

    const crackShardGeo = new THREE.OctahedronGeometry(0.12, 0);
    geographiesToDispose.push(crackShardGeo);

    for (let i = 0; i < 10; i++) {
      const angle = (i * Math.PI * 2) / 10;
      const shard = new THREE.Mesh(crackShardGeo, crackGlowMat);
      shard.position.set(
        Math.cos(angle) * 1.21,
        (i % 2 === 0 ? 1 : -1) * 0.045,
        Math.sin(angle) * 1.21,
      );
      shard.scale.set(1.75, 0.48, 0.48);
      shard.rotation.y = -angle;
      shard.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.38;
      crackRingGroup.add(shard);
    }

    // 5. ドーム底面の接地ドロップシャドウ
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 128;
    shadowCanvas.height = 128;
    const ctx = shadowCanvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 46);
      grad.addColorStop(0, 'rgba(30, 27, 24, 0.36)');
      grad.addColorStop(0.55, 'rgba(30, 27, 24, 0.13)');
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
    const shadowGeo = new THREE.PlaneGeometry(2.2, 2.2);
    geographiesToDispose.push(shadowGeo);
    const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.position.y = -1.28;
    scene.add(shadowMesh);

    const prefersReducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let animationFrameId = 0;
    const startTimeMs = performance.now();

    const renderLoop = () => {
      const elapsed = (performance.now() - startTimeMs) * 0.001;
      const progress = crackProgressRef.current;
      const dragX = dragOffsetXRef.current;
      const pressing = isPressingRef.current;
      const imp = impulseRef.current;

      imp.wobble *= 0.9;
      imp.spinBoost *= 0.92;
      imp.squash *= 0.86;

      // スワイプ量に応じた3D空間内のX移動と立体ロール回転
      const targetPosX = (dragX / 130) * 0.55;
      rootGroup.position.x += (targetPosX - rootGroup.position.x) * 0.35;

      // 長押しチャージ中の3Dバイブレーション
      const pressJitter = pressing ? Math.sin(elapsed * 55) * 0.055 : 0;

      if (!prefersReducedMotion) {
        const dragSpin = (dragX / 130) * 0.04;
        rootGroup.rotation.y += 0.012 + imp.spinBoost + dragSpin + (pressing ? 0.035 : 0);
        rootGroup.position.y = Math.sin(elapsed * 2.6) * 0.07;
      }

      const wobbleAngle = Math.sin(elapsed * 28) * imp.wobble;
      const dragTiltZ = -(dragX / 130) * 0.32;
      rootGroup.rotation.z = -0.08 + wobbleAngle + dragTiltZ + pressJitter;

      const pressScaleBoost = pressing ? 0.045 : 0;
      const scaleY = 1 - imp.squash * 0.35 - pressScaleBoost;
      const scaleXZ = 1 + imp.squash * 0.22 + pressScaleBoost;
      rootGroup.scale.set(scaleXZ, scaleY, scaleXZ);

      // ヒビ割れ進行または長押しチャージに応じて3D上半球がパカッと浮き上がり内部が発光
      const targetGap = progress * 0.16 + (pressing ? 0.06 : 0);
      topDomeGroup.position.y += (targetGap - topDomeGroup.position.y) * 0.22;
      topDomeGroup.rotation.z += (-progress * 0.1 - topDomeGroup.rotation.z) * 0.22;

      prizeGroup.rotation.y = elapsed * 1.8;
      innerLight.intensity = 0.9 + progress * 2.4 + (pressing ? 1.5 : 0);

      crackRingGroup.visible = progress > 0 || pressing;
      const ringPulse = 1 + Math.sin(elapsed * 20) * 0.045 * Math.max(progress, pressing ? 1 : 0);
      crackRingGroup.scale.setScalar(ringPulse);
      crackRingGroup.rotation.y = -elapsed * 1.4;

      const shadowScale = 1 - rootGroup.position.y * 0.25;
      shadowMesh.position.x = rootGroup.position.x * 0.85;
      shadowMesh.scale.set(shadowScale, shadowScale, 1);

      renderer.render(scene, camera);
      animationFrameId = window.requestAnimationFrame(renderLoop);
    };

    renderLoop();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const nextWidth = Math.max(entry.contentRect.width, 120);
        const nextHeight = Math.max(entry.contentRect.height, 120);
        camera.aspect = nextWidth / nextHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(nextWidth, nextHeight, false);
      });
      resizeObserver.observe(container);
    }

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver?.disconnect();
      envTarget.dispose();
      shadowTexture.dispose();
      geographiesToDispose.forEach((geo) => geo.dispose());
      materialsToDispose.forEach((mat) => mat.dispose());
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid="three-capsule-canvas"
      data-capsule-color={capsuleColor}
      className="relative h-56 w-56 sm:h-64 sm:w-64 flex items-center justify-center pointer-events-none"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
};
