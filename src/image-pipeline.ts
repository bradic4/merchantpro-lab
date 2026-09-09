import sharp from 'sharp';

export type ImageProfile = 'thumb' | 'medium' | 'large' | 'banner' | 'custom';

export interface ProfileConfig {
  maxWidth: number;
  maxHeight?: number;
  quality: number;
  format: 'webp' | 'avif';
}

export const PROFILE_CONFIGS: Record<Exclude<ImageProfile, 'custom'>, ProfileConfig> = {
  thumb: { maxWidth: 320, quality: 80, format: 'webp' },
  medium: { maxWidth: 800, quality: 80, format: 'webp' },
  large: { maxWidth: 1600, quality: 82, format: 'webp' },
  banner: { maxWidth: 1200, quality: 80, format: 'webp' },
};

export interface OptimizeOptions {
  profile?: ImageProfile;
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  format?: 'webp' | 'avif';
  minSavingsPercent?: number;
  minSavingsBytes?: number;
  force?: boolean;
}

export interface OptimizeResult {
  buffer: Buffer;
  format: string;
  width: number;
  height: number;
  originalBytes: number;
  optimizedBytes: number;
  savedBytes: number;
  savedPercent: number;
  skipped: boolean;
  skipReason?: string;
}

export interface ResponsiveVariant {
  profile: ImageProfile;
  filename: string;
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
}

export interface ResponsiveSetResult {
  variants: ResponsiveVariant[];
  totalOriginalBytes: number;
  totalOptimizedBytes: number;
  suggestedSrcset: string;
  suggestedSizes: string;
}

/**
 * Optimizes an image buffer using sharp with conservative quality and resize rules.
 */
export async function optimizeImage(
  input: Buffer | Uint8Array,
  options: OptimizeOptions = {}
): Promise<OptimizeResult> {
  const inputBuffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const originalBytes = inputBuffer.length;

  const instance = sharp(inputBuffer, { failOnError: false });
  const metadata = await instance.metadata();

  if ((metadata.pages ?? 1) > 1) throw new Error('Animirane i višestranične slike se ne obrađuju.');
  const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
  const originalWidth = (rotated ? metadata.height : metadata.width) ?? 0;
  const originalHeight = (rotated ? metadata.width : metadata.height) ?? 0;
  const originalFormat = metadata.format ?? 'unknown';

  const profile = options.profile ?? 'custom';
  if (profile !== 'custom' && !Object.hasOwn(PROFILE_CONFIGS, profile)) throw new Error('Nepoznat profil slike.');
  const profileDefaults = profile !== 'custom' ? PROFILE_CONFIGS[profile] : null;

  const targetFormat = options.format ?? profileDefaults?.format ?? 'webp';
  const targetQuality = options.quality ?? profileDefaults?.quality ?? 80;
  const maxWidth = options.maxWidth ?? profileDefaults?.maxWidth;
  const maxHeight = options.maxHeight ?? profileDefaults?.maxHeight;

  if (!['webp', 'avif'].includes(targetFormat)) throw new Error('Nepodržan format.');
  for (const value of [maxWidth, maxHeight]) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) throw new Error('Dimenzije moraju biti pozitivni celi brojevi.');
  }
  if (!Number.isInteger(targetQuality) || targetQuality < 1 || targetQuality > 100) throw new Error('Kvalitet mora biti 1–100.');
  // Auto-rotate according to EXIF orientation, then strip orientation tag
  let pipeline = sharp(inputBuffer).rotate();

  // Resize only if image is strictly larger than max dimensions (never upscale)
  let needsResize = false;
  if (maxWidth && originalWidth > maxWidth) needsResize = true;
  if (maxHeight && originalHeight > maxHeight) needsResize = true;

  if (needsResize) {
    pipeline = pipeline.resize({
      width: maxWidth,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  if (targetFormat === 'webp') {
    pipeline = pipeline.webp({ quality: targetQuality, effort: 4 });
  } else if (targetFormat === 'avif') {
    pipeline = pipeline.avif({ quality: targetQuality, effort: 4 });
  }

  const optimizedBuffer = await pipeline.toBuffer();
  const optimizedBytes = optimizedBuffer.length;
  const savedBytes = originalBytes - optimizedBytes;
  const savedPercent = (savedBytes / originalBytes) * 100;

  const minSavingsPercent = options.minSavingsPercent ?? 8;
  const minSavingsBytes = options.minSavingsBytes ?? 2048;

  // Skip optimization if no meaningful size reduction and dimensions were not resized
  const meaningfulSavings = savedBytes >= minSavingsBytes || savedPercent >= minSavingsPercent;
  if (!options.force && !needsResize && !meaningfulSavings) {
    return {
      buffer: inputBuffer,
      format: originalFormat,
      width: originalWidth,
      height: originalHeight,
      originalBytes,
      optimizedBytes: originalBytes,
      savedBytes: 0,
      savedPercent: 0,
      skipped: true,
      skipReason: `Slika je već optimalne veličine (${(originalBytes / 1024).toFixed(1)} kB, ušteda manja od ${minSavingsPercent}%).`,
    };
  }

  const finalMeta = await sharp(optimizedBuffer).metadata();

  return {
    buffer: optimizedBuffer,
    format: targetFormat,
    width: finalMeta.width ?? originalWidth,
    height: finalMeta.height ?? originalHeight,
    originalBytes,
    optimizedBytes,
    savedBytes,
    savedPercent,
    skipped: false,
  };
}

/**
 * Generates a responsive set (thumb, medium, large) for catalog and product views.
 */
export async function generateResponsiveSet(
  input: Buffer | Uint8Array,
  baseFilename: string
): Promise<ResponsiveSetResult> {
  const inputBuffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const originalBytes = inputBuffer.length;
  const cleanBase = baseFilename.replace(/\.[^/.]+$/, '');

  const profiles: ('thumb' | 'medium' | 'large')[] = ['thumb', 'medium', 'large'];
  const variants: ResponsiveVariant[] = [];

  for (const p of profiles) {
    const res = await optimizeImage(inputBuffer, { profile: p, force: true });
    if (variants.some(v => v.width === res.width)) continue;
    variants.push({
      profile: p,
      filename: `${cleanBase}-${p}.${res.format}`,
      buffer: res.buffer,
      width: res.width,
      height: res.height,
      bytes: res.optimizedBytes,
    });
  }

  const srcsetParts = variants.map(v => `${v.filename} ${v.width}w`);
  const suggestedSrcset = srcsetParts.join(', ');
  const suggestedSizes = '(max-width: 640px) 320px, (max-width: 1024px) 800px, 1600px';

  return {
    variants,
    totalOriginalBytes: originalBytes,
    totalOptimizedBytes: variants.reduce((sum, v) => sum + v.bytes, 0),
    suggestedSrcset,
    suggestedSizes,
  };
}
