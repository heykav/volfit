// Small animation helpers. Every one of them collapses to an instant update under prefers-reduced-motion.
export const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const ease = {
  out: t => 1 - Math.pow(1 - t, 3),
  inOut: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

const running = new Map();
export function tween(key, dur, fn, easing = ease.out) {
  if (running.has(key)) running.get(key)();
  return new Promise(resolve => {
    if (reduced() || dur <= 0) { fn(1); resolve(); return; }
    let cancelled = false;
    running.set(key, () => { cancelled = true; resolve(); });
    const t0 = performance.now();
    const step = now => {
      if (cancelled) return;
      const p = Math.min(1, (now - t0) / dur);
      fn(easing(p));
      if (p < 1) requestAnimationFrame(step); else { running.delete(key); resolve(); }
    };
    requestAnimationFrame(step);
  });
}

export function cancelTween(key) { if (running.has(key)) { running.get(key)(); running.delete(key); } }

// Counts a number up (or across) to its new value; dataset.value always holds the true final value.
export function animateNumber(el, to, { decimals = 1, prefix = '', suffix = '', dur = 800 } = {}) {
  const from = Number(el.dataset.value);
  const fmt = v => prefix + v.toFixed(decimals) + suffix;
  el.dataset.value = String(to);
  const start = Number.isFinite(from) ? from : 0;
  el.classList.remove('sk');
  return tween(el, dur, p => { el.textContent = fmt(start + (to - start) * p); });
}
