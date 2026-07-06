'use client';

// POC — load ONE CC BY-SA anatomy GLB (public/models/hand.glb) in a plain
// Three.js viewer: orbit controls, click-to-identify a structure by its glTF
// node name, and isolate-on-click. Not the full feature — just validation.

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Category container nodes (from the GLB) — we want the SPECIFIC structure a
// mesh belongs to, not its category, so we skip these when resolving names.
const CATEGORIES = new Set(['Bones', 'Muscles', 'Fascia', 'Overlays', 'Cartilages', 'Ligaments', 'Veins', 'Arteries', 'Nerves', 'Bursae', 'Scene']);
const GENERIC = /^mesh[._]?\d+$/i;

export default function AnatomyTestPage() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus]     = useState('Зареждане на модела…');
  const [selected, setSelected] = useState<string | null>(null);
  const [isolated, setIsolated] = useState(false);
  const [meshCount, setMeshCount] = useState(0);
  const apiRef = useRef<{ showAll: () => void } | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1117);

    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / mount.clientHeight, 0.01, 5000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    // Lighting — hemisphere + key/fill so the colored model reads well.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(1, 2, 3); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(-2, -1, -2); scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const meshes: THREE.Mesh[] = [];
    let root: THREE.Object3D | null = null;
    let disposed = false;
    let rafId = 0;

    // Resolve a raycast hit up to its named anatomical structure node.
    function resolveStructure(obj: THREE.Object3D): THREE.Object3D {
      let o: THREE.Object3D | null = obj;
      while (o && o.parent) {
        if (o.name && !GENERIC.test(o.name) && !CATEGORIES.has(o.name)) return o;
        o = o.parent;
      }
      return obj;
    }
    function isAncestor(anc: THREE.Object3D, node: THREE.Object3D): boolean {
      let p: THREE.Object3D | null = node.parent;
      while (p) { if (p === anc) return true; p = p.parent; }
      return false;
    }
    function showAll() {
      meshes.forEach((m) => { m.visible = true; });
      setIsolated(false);
    }
    apiRef.current = { showAll };

    // ── Load the model ──
    // ?model=<name> selects which GLB in /public/models to load (default hand).
    const modelName = (new URLSearchParams(window.location.search).get('model') || 'hand').replace(/[^a-z0-9-]/gi, '');
    const t0 = performance.now();
    const loader = new GLTFLoader();
    // The AnatomyTOOL GLBs are Draco-compressed (Blender export) — decode locally
    // from our self-hosted decoder in /public/draco (no external CDN).
    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/gltf/');
    loader.setDRACOLoader(draco);
    loader.load(
      `/models/${modelName}.glb`,
      (gltf) => {
        if (disposed) return;
        root = gltf.scene;
        gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });

        // Center + scale-fit to the camera.
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        gltf.scene.position.sub(center); // move model to origin
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const dist = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360));
        camera.position.set(0, size.y * 0.15, dist * 1.6);
        camera.near = maxDim / 100; camera.far = maxDim * 100; camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0); controls.update();

        scene.add(gltf.scene);
        setMeshCount(meshes.length);
        setStatus(`Заредено за ${((performance.now() - t0) / 1000).toFixed(1)} с · ${meshes.length} структури`);
      },
      (ev) => {
        if (ev.total) setStatus(`Зареждане… ${Math.round((ev.loaded / ev.total) * 100)}%`);
      },
      (err) => { console.error('GLTF load error:', err); setStatus('✗ Грешка при зареждане на модела'); },
    );

    // ── Click vs drag discrimination (so orbiting doesn't trigger selection) ──
    let downX = 0, downY = 0;
    function onPointerDown(e: PointerEvent) { downX = e.clientX; downY = e.clientY; }
    function onPointerUp(e: PointerEvent) {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5 || !root) return; // was a drag
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(meshes.filter((m) => m.visible), true);
      if (hits.length === 0) return;
      const structure = resolveStructure(hits[0].object);
      setSelected(structure.name || '(без име)');
      // Isolate: show only meshes of the clicked structure.
      meshes.forEach((m) => { m.visible = m === structure || isAncestor(structure, m); });
      setIsolated(true);
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    function onResize() {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    }
    window.addEventListener('resize', onResize);

    function animate() { rafId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      draco.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose();
          const mat = m.material;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0f1117' }}>
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />

      {/* Top bar: status */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '8px 14px', display: 'flex', gap: 16, alignItems: 'center', background: 'rgba(15,17,23,0.7)', color: '#e6e6ea', fontSize: 13, pointerEvents: 'none' }}>
        <strong style={{ color: '#fff' }}>🖐️ Anatomy POC — hand.glb</strong>
        <span style={{ color: '#9aa0b4' }}>{status}</span>
        {meshCount > 0 && <span style={{ color: '#9aa0b4', marginLeft: 'auto' }}>завърти: влачи · zoom: скрол · кликни структура за име + изолиране</span>}
      </div>

      {/* Selection panel */}
      {selected && (
        <div style={{ position: 'absolute', top: 56, left: 14, background: '#fff', color: '#111', borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.4)', padding: '12px 14px', minWidth: 220, maxWidth: 300 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: '#7B1C1C', fontWeight: 700 }}>Избрана структура</div>
          <div style={{ fontSize: 17, fontWeight: 600, marginTop: 4 }}>{selected}</div>
          {isolated && (
            <button
              onClick={() => { apiRef.current?.showAll(); setSelected(null); }}
              style={{ marginTop: 10, width: '100%', padding: '8px 10px', background: '#7B1C1C', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              ↺ Покажи всички структури
            </button>
          )}
        </div>
      )}

      {/* Attribution — CC BY-SA 4.0 obligation */}
      <div style={{ position: 'absolute', bottom: 8, left: 14, right: 14, color: '#8890a6', fontSize: 11, pointerEvents: 'none' }}>
        3D модел: <a href="https://anatomytool.org/open3dmodel" style={{ color: '#aeb6d0', pointerEvents: 'auto' }} target="_blank" rel="noopener noreferrer">Open3DModel</a> (G.J.R. Maat, E. Lee, LUMC et al.) — лиценз{' '}
        <a href="https://creativecommons.org/licenses/by-sa/4.0/" style={{ color: '#aeb6d0', pointerEvents: 'auto' }} target="_blank" rel="noopener noreferrer">CC BY-SA 4.0</a>
      </div>
    </div>
  );
}
