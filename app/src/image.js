import { clamp } from './utils.js';

async function loadImage(file) {
  if ('createImageBitmap' in window) return createImageBitmap(file, { imageOrientation: 'from-image' });
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function processAvatar(file, size = 512) {
  if (!file?.type?.startsWith('image/')) throw new Error('Wybierz plik graficzny.');
  if (file.size > 12 * 1024 * 1024) throw new Error('Zdjęcie jest za duże. Maksymalny rozmiar to 12 MB.');

  const image = await loadImage(file);
  const width = image.width || image.naturalWidth;
  const height = image.height || image.naturalHeight;
  const side = Math.min(width, height);
  const sourceX = Math.max(0, (width - side) / 2);
  const sourceY = Math.max(0, (height - side) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#000000';
  context.fillRect(0, 0, size, size);
  context.drawImage(image, sourceX, sourceY, side, side, 0, 0, size, size);
  image.close?.();

  let blob = await canvasToBlob(canvas, 'image/webp', clamp(0.84, 0.1, 1));
  let type = 'image/webp';
  if (!blob) {
    blob = await canvasToBlob(canvas, 'image/jpeg', 0.86);
    type = 'image/jpeg';
  }
  if (!blob) throw new Error('Nie udało się przetworzyć zdjęcia.');
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    type,
    width: size,
    height: size,
  };
}
