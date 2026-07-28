'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');

/*
 * Strips ALL metadata — including EXIF GPS coordinates — from an uploaded
 * image by decoding it to raw pixels and re-encoding a fresh image. A canvas
 * has no concept of EXIF, so the output carries none of the original's hidden
 * metadata (camera model, timestamps, and most importantly the latitude /
 * longitude a phone silently embeds in every photo).
 *
 * This matters because celebrity and testimonial photos are served to the
 * public exactly as stored — without this, a photo the site owner snapped on
 * their phone would broadcast the exact spot it was taken to every visitor.
 *
 * Re-encodes to JPEG (these are all photographs); any transparency is
 * flattened onto white, which is fine for face/photo content. Returns null if
 * the bytes can't be decoded as an image, so the caller can reject the upload.
 */
async function stripImageMetadata(buffer) {
  try {
    const img = await loadImage(buffer);
    if (!img.width || !img.height) return null;
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    // Flatten onto white so a transparent PNG doesn't become a black box in JPEG.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);
    const out = canvas.toBuffer('image/jpeg', 90);
    return { buffer: out, mime: 'image/jpeg' };
  } catch {
    return null;
  }
}

module.exports = { stripImageMetadata };
