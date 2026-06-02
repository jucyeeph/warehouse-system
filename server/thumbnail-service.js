const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
const THUMBNAIL_EXT = '.webp';
const THUMBNAIL_WIDTH = parseInt(process.env.THUMBNAIL_MAX_WIDTH || '600', 10);
const THUMBNAIL_QUALITY = parseInt(process.env.THUMBNAIL_QUALITY || '75', 10);

function normalizeRelPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function resolveInside(rootDir, relPath) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, ...normalizeRelPath(relPath).split('/').filter(Boolean));
  if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  throw new Error('Invalid path outside root');
}

function thumbnailRelPathForUpload(relPath) {
  return `uploads/${normalizeRelPath(relPath)}${THUMBNAIL_EXT}`;
}

function thumbnailUrlForUpload(relPath) {
  return `/thumbnails/${thumbnailRelPathForUpload(relPath).split('/').map(encodeURIComponent).join('/')}`;
}

function walkFiles(rootDir) {
  const root = path.resolve(rootDir);
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = path.join(root, relDir);
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = path.join(relDir, entry.name);
      const abs = path.join(root, rel);
      if (entry.isDirectory()) stack.push(rel);
      else if (entry.isFile()) files.push({ abs, rel: rel.replaceAll(path.sep, '/') });
    }
  }
  return files;
}

function makeStats({ dryRun = false, force = false, cleanOnly = false } = {}) {
  return {
    dryRun,
    force,
    cleanOnly,
    scannedOriginals: 0,
    skippedExisting: 0,
    generated: 0,
    regenerated: 0,
    orphanDeleted: 0,
    failed: 0,
    durationMs: 0,
    planned: {
      generate: [],
      regenerate: [],
      deleteOrphans: []
    },
    warnings: []
  };
}

async function generateThumbnail(sourceAbs, targetAbs, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  const tmpPath = `${targetAbs}.tmp-${process.pid}-${Date.now()}`;
  try {
    await sharp(sourceAbs)
      .rotate()
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .webp({ quality: THUMBNAIL_QUALITY })
      .toFile(tmpPath);
    fs.renameSync(tmpPath, targetAbs);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

async function runThumbnailScan(options = {}) {
  const {
    uploadsDir = process.env.UPLOADS_DIR || './data/uploads',
    thumbnailsDir = process.env.THUMBNAILS_DIR || './data/thumbnails',
    dryRun = false,
    force = false,
    cleanOnly = false,
    logger = console
  } = options;
  const startedAt = Date.now();
  const stats = makeStats({ dryRun, force, cleanOnly });
  const uploadRoot = path.resolve(uploadsDir);
  const thumbnailRoot = path.resolve(thumbnailsDir);
  const originals = walkFiles(uploadRoot).filter(file => IMAGE_EXTS.has(path.extname(file.rel).toLowerCase()));
  const originalRelSet = new Set(originals.map(file => file.rel));
  stats.scannedOriginals = originals.length;

  if (!cleanOnly) {
    for (const original of originals) {
      const thumbRel = thumbnailRelPathForUpload(original.rel);
      let thumbAbs;
      try {
        thumbAbs = resolveInside(thumbnailRoot, thumbRel);
        const originalStat = fs.statSync(original.abs);
        const thumbExists = fs.existsSync(thumbAbs);
        const stale = thumbExists && originalStat.mtimeMs > fs.statSync(thumbAbs).mtimeMs;
        if (thumbExists && !stale && !force) {
          stats.skippedExisting++;
          continue;
        }
        if (!thumbExists) stats.planned.generate.push({ source: original.rel, thumbnail: thumbRel });
        else stats.planned.regenerate.push({ source: original.rel, thumbnail: thumbRel });
        await generateThumbnail(original.abs, thumbAbs, dryRun);
        if (!thumbExists) stats.generated++;
        else stats.regenerated++;
      } catch (error) {
        stats.failed++;
        stats.warnings.push({ source: original.rel, error: error.message });
        logger.warn?.(`[thumbnails] failed ${original.rel}: ${error.message}`);
      }
    }
  }

  const thumbnails = walkFiles(path.join(thumbnailRoot, 'uploads')).filter(file => file.rel.endsWith(THUMBNAIL_EXT));
  for (const thumb of thumbnails) {
    const originalRel = thumb.rel.slice(0, -THUMBNAIL_EXT.length);
    if (originalRelSet.has(originalRel)) continue;
    const thumbRel = thumbnailRelPathForUpload(originalRel);
    stats.planned.deleteOrphans.push({ source: originalRel, thumbnail: thumbRel });
    try {
      if (!dryRun) fs.unlinkSync(resolveInside(thumbnailRoot, thumbRel));
      stats.orphanDeleted++;
    } catch (error) {
      stats.failed++;
      stats.warnings.push({ thumbnail: thumbRel, error: error.message });
      logger.warn?.(`[thumbnails] orphan cleanup failed ${thumbRel}: ${error.message}`);
    }
  }

  stats.durationMs = Date.now() - startedAt;
  logger.info?.(`[thumbnails] originals=${stats.scannedOriginals} skipped=${stats.skippedExisting} generated=${stats.generated} regenerated=${stats.regenerated} orphanDeleted=${stats.orphanDeleted} failed=${stats.failed} durationMs=${stats.durationMs}${dryRun ? ' dryRun=true' : ''}`);
  return stats;
}

function startThumbnailScanner(options = {}) {
  const {
    intervalMinutes = parseFloat(process.env.THUMBNAIL_SCAN_INTERVAL_MINUTES || '15'),
    initialDelayMs = parseInt(process.env.THUMBNAIL_SCAN_INITIAL_DELAY_MS || '45000', 10),
    logger = console
  } = options;
  let running = false;
  let stopped = false;
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;

  async function tick() {
    if (stopped) return;
    if (running) {
      logger.warn?.('[thumbnails] previous scan still running, skip this tick');
      return;
    }
    running = true;
    try {
      await runThumbnailScan({ ...options, logger });
    } catch (error) {
      logger.error?.(`[thumbnails] scan failed: ${error.message}`);
    } finally {
      running = false;
    }
  }

  const initialTimer = setTimeout(tick, Math.max(0, initialDelayMs));
  const intervalTimer = setInterval(tick, intervalMs);
  intervalTimer.unref?.();
  initialTimer.unref?.();
  return {
    stop() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    }
  };
}

module.exports = {
  IMAGE_EXTS,
  THUMBNAIL_EXT,
  thumbnailRelPathForUpload,
  thumbnailUrlForUpload,
  runThumbnailScan,
  startThumbnailScanner,
  resolveInside
};
