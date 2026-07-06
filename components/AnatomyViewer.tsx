'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { AnatomyTopic, sanitizeName, cleanStructureName } from '@/lib/anatomy-catalog';

interface AnatomyViewerProps {
  open: boolean;
  modelFile: string | null;   // resolves to /models/<file>.glb
  modelLabel: string;
  topic: AnatomyTopic | null; // isolate this topic (whole model if null/whole)
  onClose: () => void;
}

interface Engine {
  isolate: (cleanGroups: string[]) => number;
  showAll: () => number;
  resize: () => void;
}

const MIN_W = 440, MIN_H = 340;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isMesh(o: any): o is THREE.Mesh { return o && o.isMesh; }

export default function AnatomyViewer({ open, modelFile, modelLabel, topic, onClose }: AnatomyViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const [status, setStatus] = useState('Зареждане…');
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(0);

  // window chrome
  const [mode, setMode] = useState<'full' | 'min'>('full');
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const minimized = open && mode === 'min';

  // Reset to full whenever a new model opens.
  useEffect(() => { if (modelFile) setMode('full'); }, [modelFile]);

  // Place the floating window when entering minimized mode without a position.
  useEffect(() => {
    if (open && mode === 'min' && !pos) {
      const vw = window.innerWidth;
      setPos({ x: Math.max(8, vw - Math.min(MIN_W, vw - 16) - 24), y: 76 });
    }
  }, [open, mode, pos]);

  // ── Three.js engine: build once per model file ──────────────────────────────
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !modelFile) return;
    setReady(false); setSelected(null); setStatus('Зареждане…');

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1117);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(1, 2, 3); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(-2, -1, -2); scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const meshes: THREE.Mesh[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalName = new Map<THREE.Object3D, string>();
    let sceneRoot: THREE.Object3D | null = null;
    let disposed = false, rafId = 0;

    function sizeToMount() {
      const w = mount!.clientWidth || 1, h = mount!.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }

    function frameVisible() {
      const box = new THREE.Box3();
      meshes.forEach((m) => { if (m.visible) box.expandByObject(m); });
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const dist = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360));
      camera.position.set(center.x, center.y + size.y * 0.05, center.z + dist * 1.7);
      camera.near = maxDim / 100; camera.far = maxDim * 100; camera.updateProjectionMatrix();
      controls.target.copy(center); controls.update();
    }

    function resolveStructure(obj: THREE.Object3D): THREE.Object3D {
      // The clicked leaf mesh carries the structure name; walk up only past unnamed.
      let o: THREE.Object3D | null = obj;
      while (o && o.parent) { if (o.name) return o; o = o.parent; }
      return obj;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/gltf/');
    loader.setDRACOLoader(draco);

    loader.load(
      `/models/${modelFile}.glb`,
      (gltf) => {
        if (disposed) { return; }
        sceneRoot = gltf.scene;
        // capture ORIGINAL (unsanitized) names via GLTF associations for clean display
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parser: any = gltf.parser;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const jsonNodes: any[] = parser?.json?.nodes ?? [];
        gltf.scene.traverse((o) => {
          if (isMesh(o)) meshes.push(o);
          try {
            const a = parser?.associations?.get(o);
            const idx = a?.nodes ?? a?.index;
            if (typeof idx === 'number' && jsonNodes[idx]?.name) originalName.set(o, jsonNodes[idx].name);
          } catch { /* associations shape varies by version — fall back below */ }
        });

        const box = new THREE.Box3().setFromObject(gltf.scene);
        const center = box.getCenter(new THREE.Vector3());
        gltf.scene.position.sub(center);
        scene.add(gltf.scene);
        sizeToMount();
        frameVisible();
        setVisibleCount(meshes.length);
        setReady(true);
        setStatus(`${meshes.length} структури`);

        engineRef.current = {
          isolate: (cleanGroups: string[]) => {
            const wanted = new Set(cleanGroups.map(sanitizeName));
            const keep = new Set<THREE.Object3D>();
            (sceneRoot?.children ?? []).forEach((g) => {
              if (wanted.has(g.name)) g.traverse((o) => { if (isMesh(o)) keep.add(o); });
            });
            meshes.forEach((m) => { m.visible = keep.has(m); });
            frameVisible();
            setVisibleCount(keep.size);
            return keep.size;
          },
          showAll: () => {
            meshes.forEach((m) => { m.visible = true; });
            frameVisible();
            setVisibleCount(meshes.length);
            return meshes.length;
          },
          resize: sizeToMount,
        };
      },
      (ev) => { if (ev.total) setStatus(`Зареждане… ${Math.round((ev.loaded / ev.total) * 100)}%`); },
      (err) => { console.error('Anatomy GLTF load error:', err); setStatus('✗ Грешка при зареждане'); },
    );

    // click vs drag discrimination
    let downX = 0, downY = 0;
    function onDown(e: PointerEvent) { downX = e.clientX; downY = e.clientY; }
    function onUp(e: PointerEvent) {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5 || !sceneRoot) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(meshes.filter((m) => m.visible), true);
      if (!hits.length) return;
      const s = resolveStructure(hits[0].object);
      setSelected(cleanStructureName(originalName.get(s) ?? s.name));
    }
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);

    const ro = new ResizeObserver(() => sizeToMount());
    ro.observe(mount);

    function animate() { rafId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      controls.dispose(); draco.dispose();
      scene.traverse((o) => {
        if (isMesh(o)) {
          o.geometry?.dispose();
          const mat = o.material;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      engineRef.current = null;
    };
  }, [modelFile]);

  // ── Apply the topic (isolate / show all) once the engine is ready ───────────
  useEffect(() => {
    if (!ready || !engineRef.current) return;
    if (topic && !topic.whole && topic.groups.length) engineRef.current.isolate(topic.groups);
    else engineRef.current.showAll();
  }, [ready, topic?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep canvas sized when the window mode/position changes
  useEffect(() => { engineRef.current?.resize(); }, [mode, pos, open]);

  // ── Dragging (minimized title bar) ──────────────────────────────────────────
  function onPointerDown(e: React.PointerEvent) {
    if (mode !== 'min' || !pos || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const w = boxRef.current?.offsetWidth ?? MIN_W, h = boxRef.current?.offsetHeight ?? MIN_H;
    setPos({
      x: clamp(e.clientX - dragRef.current.dx, 8, window.innerWidth - w - 8),
      y: clamp(e.clientY - dragRef.current.dy, 8, window.innerHeight - h - 8),
    });
  }
  function onPointerUp(e: React.PointerEvent) {
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  }

  if (!open) return null;

  const base: React.CSSProperties = { display: 'flex', flexDirection: 'column', backgroundColor: '#0b0b12', zIndex: 70 };
  const style: React.CSSProperties = minimized
    ? { ...base, position: 'fixed', left: pos?.x ?? 0, top: pos?.y ?? 0, width: `min(${MIN_W}px, calc(100vw - 16px))`, height: `${MIN_H}px`, borderRadius: 12, overflow: 'hidden', boxShadow: '0 12px 48px rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.1)' }
    : { ...base, position: 'fixed', inset: 0 };

  return (
    <div ref={boxRef} style={style} aria-label="3D анатомичен модел">
      {/* Title bar (drag handle when minimized) */}
      <div
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        className="flex items-center justify-between flex-shrink-0"
        style={{ backgroundColor: '#7B1C1C', padding: minimized ? '5px 8px 5px 10px' : '9px 14px', cursor: minimized ? 'move' : 'default', touchAction: minimized ? 'none' : 'auto' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-white" aria-hidden="true" style={{ fontSize: minimized ? 14 : 17 }}>🦴</span>
          <div className="flex flex-col min-w-0">
            <span className="text-white font-semibold leading-tight truncate" style={{ fontSize: minimized ? 12 : 14 }}>
              {modelLabel}{topic && !topic.whole ? ` · ${topic.label}` : ''}
            </span>
            {!minimized && <span className="text-red-200 text-xs mt-0.5 truncate">{selected ? `Избрано: ${selected}` : status}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {ready && (
            <button onClick={() => { setSelected(null); engineRef.current?.showAll(); }}
              className="hidden sm:inline text-xs text-white/90 hover:text-white border border-white/30 rounded px-2 py-1 mr-1 hover:bg-white/10 transition-colors"
              title="Покажи всичко">Покажи всичко</button>
          )}
          {minimized ? (
            <button onClick={() => setMode('full')} className="w-7 h-7 rounded-md flex items-center justify-center text-white hover:bg-white/20" aria-label="Цял екран" title="Цял екран">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" /></svg>
            </button>
          ) : (
            <button onClick={() => setMode('min')} className="w-8 h-8 rounded-lg flex items-center justify-center text-white hover:bg-white/20" aria-label="Намали" title="Намали">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" /></svg>
            </button>
          )}
          <button onClick={onClose} className={`rounded-lg flex items-center justify-center text-white hover:bg-white/20 ${minimized ? 'w-7 h-7' : 'w-8 h-8'}`} aria-label="Затвори" title="Затвори">
            <svg className={minimized ? 'w-4 h-4' : 'w-5 h-5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      {/* Canvas + overlays */}
      <div className="flex-1 relative overflow-hidden" style={{ background: '#0f1117' }}>
        <div ref={mountRef} className="absolute inset-0" />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-300 text-sm gap-2 pointer-events-none">
            <div className="w-5 h-5 border-2 border-gray-600 border-t-white rounded-full animate-spin" />{status}
          </div>
        )}
        {ready && !minimized && (
          <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between text-[11px] text-gray-400 pointer-events-none">
            <span>завърти: влачи · zoom: скрол · кликни структура за име</span>
            <span>{visibleCount} видими</span>
          </div>
        )}
        {selected && !minimized && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-black/70 text-white text-sm font-medium max-w-[80%] truncate">
            {selected}
          </div>
        )}
      </div>
    </div>
  );
}
