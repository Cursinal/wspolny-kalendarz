import { createRandomUuid } from './platform-crypto.js';

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

export function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  const { className, text, html, dataset, attrs, on, ...props } = options;

  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  if (html !== undefined) node.innerHTML = html;
  if (dataset) Object.assign(node.dataset, dataset);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null && value !== false) {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  if (on) {
    for (const [eventName, handler] of Object.entries(on)) {
      node.addEventListener(eventName, handler);
    }
  }
  Object.assign(node, props);

  const normalized = Array.isArray(children) ? children : [children];
  for (const child of normalized) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function button(label, options = {}) {
  return element('button', {
    type: 'button',
    className: options.className ?? 'button',
    attrs: options.attrs,
    dataset: options.dataset,
    on: options.on,
  }, label);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function randomId(prefix = '') {
  return `${prefix}${createRandomUuid()}`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export function debounce(fn, delay = 250) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeHexColor(value, fallback = '#ff7aa8') {
  if (/^#[0-9a-f]{6}$/i.test(value ?? '')) return value.toLowerCase();
  return fallback;
}

export function minuteLabel(totalMinutes) {
  if (totalMinutes === 1440) return '24:00';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function timeToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value ?? '')) return null;
  const [hours, minutes] = value.split(':').map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function sortIntervals(intervals) {
  return [...intervals]
    .filter((interval) => timeToMinutes(interval.from) !== null && timeToMinutes(interval.to) !== null)
    .sort((a, b) => timeToMinutes(a.from) - timeToMinutes(b.from));
}

export function sanitizeFilename(value, fallback = 'eksport') {
  const result = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return result || fallback;
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function showToast(message, type = 'info', timeout = 3_500) {
  const region = document.querySelector('#toast-region');
  if (!region) return;
  const toast = element('div', {
    className: `toast toast--${type}`,
    attrs: { role: type === 'error' ? 'alert' : 'status' },
  }, [
    element('span', { className: 'toast__dot', attrs: { 'aria-hidden': 'true' } }),
    element('span', { text: message }),
  ]);
  region.append(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 220);
  }, timeout);
}

export function setBusy(buttonElement, busy, busyLabel = 'Pracuję…') {
  if (!buttonElement) return;
  if (busy) {
    buttonElement.dataset.originalLabel = buttonElement.textContent;
    buttonElement.textContent = busyLabel;
    buttonElement.disabled = true;
    buttonElement.setAttribute('aria-busy', 'true');
  } else {
    buttonElement.textContent = buttonElement.dataset.originalLabel || buttonElement.textContent;
    buttonElement.disabled = false;
    buttonElement.removeAttribute('aria-busy');
    delete buttonElement.dataset.originalLabel;
  }
}
