<script setup lang="ts">
// Animated dot field — a canvas grid behind the app where a wave travels
// diagonally and dots light up near the pointer. Dots are drawn from a
// pre-rendered sprite (one drawImage per dot) so a 3k-dot grid stays cheap.
// Respects prefers-reduced-motion by drawing a single static frame.
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useThemeStore } from '../stores/theme';

const theme = useThemeStore();
const canvas = ref<HTMLCanvasElement | null>(null);

const SPACING = 30;
const DOT_RADIUS = 2.4; // sprite half-size in CSS px
const POINTER_RANGE = 160;

interface Dot { x: number; y: number; hit: number }
let ctx: CanvasRenderingContext2D | null = null;
let sprite: HTMLCanvasElement | null = null;
let dots: Dot[] = [];
let width = 0;
let height = 0;
let dpr = 1;
let raf = 0;
let started = 0;
let reduced = false;
const pointer = { x: -9999, y: -9999 };

function rgb(): string {
  return theme.theme === 'dark' ? '255,255,255' : '30,27,24';
}

/** Pre-rendered radial dot; per-dot alpha and scale go through drawImage. */
function buildSprite(): void {
  const size = Math.ceil(DOT_RADIUS * 2 * 2);
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (!g) return;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, `rgba(${rgb()},0.95)`);
  grd.addColorStop(0.45, `rgba(${rgb()},0.5)`);
  grd.addColorStop(1, `rgba(${rgb()},0)`);
  g.fillStyle = grd;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  g.fill();
  sprite = c;
}

function layout(): void {
  const el = canvas.value;
  if (!el) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  width = window.innerWidth;
  height = window.innerHeight;
  el.width = Math.floor(width * dpr);
  el.height = Math.floor(height * dpr);
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  ctx = el.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  dots = [];
  for (let y = SPACING / 2; y < height; y += SPACING) {
    for (let x = SPACING / 2; x < width; x += SPACING) dots.push({ x, y, hit: 0 });
  }
}

function frame(now: number): void {
  raf = requestAnimationFrame(frame);
  if (!ctx || !sprite) return;
  const t = (now - started) / 1000;
  const dim = theme.theme === 'dark';
  const base = dim ? 0.42 : 0.34;
  ctx.clearRect(0, 0, width, height);
  for (const d of dots) {
    // travelling diagonal wave
    const wave = (Math.sin((d.x + d.y) * 0.0055 - t * 1.2) + 1) / 2;
    // eased pointer proximity
    const dx = d.x - pointer.x;
    const dy = d.y - pointer.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const target = dist < POINTER_RANGE ? 1 - dist / POINTER_RANGE : 0;
    d.hit += (target - d.hit) * 0.14;
    const scale = 0.35 + wave * 0.8 + d.hit * 1.4;
    const alpha = base * (0.22 + wave * 1.05) + d.hit * 0.6;
    const s = DOT_RADIUS * 2 * scale;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(sprite, d.x - s / 2, d.y - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
}

function onPointerMove(e: PointerEvent): void {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
}

function onPointerLeave(): void {
  pointer.x = -9999;
  pointer.y = -9999;
}

onMounted(() => {
  reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  buildSprite();
  layout();
  if (reduced) {
    frame(performance.now()); // single static frame
    cancelAnimationFrame(raf);
    raf = 0;
  } else {
    started = performance.now();
    raf = requestAnimationFrame(frame);
  }
  window.addEventListener('resize', layout);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('mouseleave', onPointerLeave);
});

onUnmounted(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener('resize', layout);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerleave', onPointerLeave);
  document.removeEventListener('mouseleave', onPointerLeave);
});

watch(() => theme.theme, () => {
  buildSprite();
  if (reduced) {
    frame(performance.now());
    cancelAnimationFrame(raf);
    raf = 0;
  }
});
</script>

<template>
  <canvas ref="canvas" class="dot-field" aria-hidden="true" />
</template>

<style scoped>
.dot-field {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}
</style>
