import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type CapsuleColorVariant = 'blue' | 'red' | 'gold';

export interface ThreeCapsuleCanvasProps {
  capsuleColor: CapsuleColorVariant;
  crackProgress: number;
  interactionTrigger: number;
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
  const crackProgressRef = useRef<number>(crackProgress);

  useEffect(() => {
    crackProgressRef.current = crackProgress;
    impulseRef.current.wobble = 0.42 + crackProgress * 0.18;
    impulseRef.current.squash = 0.22;
    impulseRef.current.spinBoost = 0.16;
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

    impulseRef.current.spinBoost = 0.32;
    impulseRef.current.squash = 0.18;
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

    const width = container.clientWidth || 240;
    const height = container.clientHeight || 240;
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

    const innerLight = new THREE.PointLight(0xffd166, 0.8, 4.5);
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

    const initialPalette = CAPSULE_PALETTE[capsuleColor];
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

    // 4. クラック発光リング＆稲妻シャード（ヒビ割れ進行時に出現）
    const crackRingGroup = new THREE.Group();
    crackRingGroupRef.current = crackRingGroup;
    rootGroup.add(crackRingGroup);

    const crackGlowMat = new THREE.MeshBasicMaterial({
      color: 0xfff3b0,
    });
    materialsToDispose.push(crackGlowMat);

    const crackShardGeo = new THREE.OctahedronGeometry(0.11, 0);
    geographiesToDispose.push(crackShardGeo);

    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI * 2) / 8;
      const shard = new THREE.Mesh(crackShardGeo, crackGlowMat);
      shard.position.set(
        Math.cos(angle) * 1.19,
        (i % 2 === 0 ? 1 : -1) * 0.04,
        Math.sin(angle) * 1.19,
      );
      shard.scale.set(1.6, 0.45, 0.45);
      shard.rotation.y = -angle;
      shard.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.35;
      crackRingGroup.add(shard);
    }

    // 5. ドーム底面の接地ドロップシャドウ
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 128;
    shadowCanvas.height = 128;
    const ctx = shadowCanvas.getContext('2d');
    if (ctx) {
      const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 46);
      grad.addColorStop(0, 'rgba(30, 27, 24, 0.34)');
      grad.addColorStop(0.55, 'rgba(30, 27, 24, 0.12)');
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
    const shadowGeo = new THREE.PlaneGeometry(2.1, 2.1);
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
      const imp = impulseRef.current;

      imp.wobble *= 0.9;
      imp.spinBoost *= 0.92;
      imp.squash *= 0.86;

      if (!prefersReducedMotion) {
        rootGroup.rotation.y += 0.012 + imp.spinBoost;
        rootGroup.position.y = Math.sin(elapsed * 2.6) * 0.07;
      }

      const wobbleAngle = Math.sin(elapsed * 28) * imp.wobble;
      rootGroup.rotation.z = -0.08 + wobbleAngle;

      const scaleY = 1 - imp.squash * 0.35;
      const scaleXZ = 1 + imp.squash * 0.22;
      rootGroup.scale.set(scaleXZ, scaleY, scaleXZ);

      // ヒビ割れ進行に応じて上半球がパカッと浮き上がり内部が発光
      const targetGap = progress * 0.14;
      topDomeGroup.position.y += (targetGap - topDomeGroup.position.y) * 0.2;
      topDomeGroup.rotation.z += (-progress * 0.09 - topDomeGroup.rotation.z) * 0.2;

      prizeGroup.rotation.y = elapsed * 1.8;
      innerLight.intensity = 0.8 + progress * 2.2;

      crackRingGroup.visible = progress > 0;
      crackRingGroup.scale.setScalar(1 + Math.sin(elapsed * 18) * 0.04 * progress);

      const shadowScale = 1 - rootGroup.position.y * 0.25;
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
  }, [capsuleColor]);

  return (
    <div
      ref={containerRef}
      data-testid="three-capsule-canvas"
      data-capsule-color={capsuleColor}
      className="relative h-56 w-56 sm:h-60 sm:w-60 flex items-center justify-center pointer-events-none"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
};
