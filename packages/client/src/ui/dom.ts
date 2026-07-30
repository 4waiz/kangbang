/**
 * Minimal DOM helpers.
 *
 * Vanilla DOM rather than a framework: the HUD updates 60 times a second and a
 * virtual DOM diff on every frame would be the single largest CPU cost in the
 * client. Menus are rebuilt on navigation only, which is rare enough that
 * imperative construction is both faster and easier to reason about.
 */

import { audio } from '../engine/audio.js';

export type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value as Partial<CSSStyleDeclaration>);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(node.dataset, value as Record<string, string>);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  append(node, ...children);
  return node;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Button with the standard hover/click sounds already wired. */
export function button(
  label: Child,
  onClick: () => void,
  opts: { class?: string; hint?: string; disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  const btn = el(
    'button',
    {
      class: `btn ${opts.class ?? ''}`.trim(),
      type: 'button',
      disabled: opts.disabled,
      title: opts.title,
      onmouseenter: () => audio.uiHover(),
      onclick: () => {
        audio.uiClick();
        onClick();
      },
    },
    label,
    opts.hint ? el('span', { class: 'btn__hint' }, opts.hint) : null,
  );
  return btn;
}

export function slider(opts: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  help?: string;
  onInput: (v: number) => void;
}): HTMLElement {
  const valueNode = el('span', { class: 'field__value' }, (opts.format ?? String)(opts.value));
  const input = el('input', {
    type: 'range',
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step),
    value: String(opts.value),
    oninput: (ev: Event) => {
      const v = Number((ev.target as HTMLInputElement).value);
      valueNode.textContent = (opts.format ?? String)(v);
      updateFill(ev.target as HTMLInputElement, opts.min, opts.max);
      opts.onInput(v);
    },
  });
  updateFill(input, opts.min, opts.max);
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field__label' }, el('span', {}, opts.label), valueNode),
    input,
    opts.help ? el('span', { class: 'field__help' }, opts.help) : null,
  );
}

function updateFill(input: HTMLInputElement, min: number, max: number): void {
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

export function toggle(opts: { label: string; value: boolean; help?: string; onChange: (v: boolean) => void }): HTMLElement {
  const input = el('input', {
    type: 'checkbox',
    checked: opts.value,
    onchange: (ev: Event) => {
      audio.uiClick();
      opts.onChange((ev.target as HTMLInputElement).checked);
    },
  });
  return el(
    'div',
    { class: 'field' },
    el(
      'label',
      { class: 'toggle' },
      input,
      el('span', { class: 'toggle__track' }),
      el('span', { class: 'field__label', style: { margin: '0' } }, opts.label),
    ),
    opts.help ? el('span', { class: 'field__help' }, opts.help) : null,
  );
}

export function select(opts: {
  label: string;
  value: string | number;
  options: { value: string | number; label: string }[];
  help?: string;
  onChange: (v: string) => void;
}): HTMLElement {
  const sel = el(
    'select',
    {
      onchange: (ev: Event) => {
        audio.uiClick();
        opts.onChange((ev.target as HTMLSelectElement).value);
      },
    },
    ...opts.options.map((o) =>
      el('option', { value: String(o.value), selected: String(o.value) === String(opts.value) }, o.label),
    ),
  );
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field__label' }, opts.label),
    sel,
    opts.help ? el('span', { class: 'field__help' }, opts.help) : null,
  );
}

export function segmented(opts: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}): HTMLElement {
  const wrap = el('div', { class: 'segmented' });
  for (const o of opts.options) {
    const b = el(
      'button',
      {
        type: 'button',
        'aria-pressed': String(o.value === opts.value),
        onmouseenter: () => audio.uiHover(),
        onclick: () => {
          audio.uiClick();
          for (const child of Array.from(wrap.children)) child.setAttribute('aria-pressed', 'false');
          b.setAttribute('aria-pressed', 'true');
          opts.onChange(o.value);
        },
      },
      o.label,
    );
    wrap.appendChild(b);
  }
  return wrap;
}

export function bar(fraction: number, opts: { class?: string } = {}): HTMLElement {
  return el(
    'div',
    { class: `bar ${opts.class ?? ''}`.trim() },
    el('i', { class: 'bar__fill', style: { width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` } }),
  );
}

export function chip(label: Child, cls = ''): HTMLElement {
  return el('span', { class: `chip ${cls}`.trim() }, label);
}

export function statBlock(value: Child, label: string): HTMLElement {
  return el('div', { class: 'stat' }, el('div', { class: 'stat__value mono' }, value), el('div', { class: 'stat__label' }, label));
}

export function eyebrow(text: string): HTMLElement {
  return el('div', { class: 'eyebrow' }, text);
}

let toastTimer = 0;
export function toast(message: string, error = false): void {
  const existing = document.querySelector('.toast');
  existing?.remove();
  const node = el('div', { class: `toast${error ? ' toast--error' : ''}` }, message);
  document.body.appendChild(node);
  if (error) audio.uiError();
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), 3200);
}

export function fmtNumber(v: number): string {
  if (!Number.isFinite(v)) return '0';
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(1)}k`;
  return Math.round(v).toLocaleString();
}

export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function fmtDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
