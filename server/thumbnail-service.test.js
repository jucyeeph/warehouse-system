const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { runThumbnailScan, thumbnailRelPathForUpload } = require('./thumbnail-service');

test('thumbnail scan builds cache beside uploads without touching originals and cleans orphans', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-thumbs-'));
  const uploadsDir = path.join(tmp, 'uploads');
  const thumbnailsDir = path.join(tmp, 'thumbnails');
  const rel = '2026-05-26/BOX001/POMCMP123456_BOX001.jpg';
  const original = path.join(uploadsDir, rel);
  fs.mkdirSync(path.dirname(original), { recursive: true });
  await sharp({ create: { width: 900, height: 500, channels: 3, background: '#336699' } }).jpeg().toFile(original);
  const originalBefore = fs.statSync(original).mtimeMs;

  const dry = await runThumbnailScan({ uploadsDir, thumbnailsDir, dryRun: true, logger: { info() {}, warn() {} } });
  assert.equal(dry.generated, 1);
  assert.equal(fs.existsSync(path.join(thumbnailsDir, thumbnailRelPathForUpload(rel))), false);

  const scan = await runThumbnailScan({ uploadsDir, thumbnailsDir, logger: { info() {}, warn() {} } });
  const thumb = path.join(thumbnailsDir, thumbnailRelPathForUpload(rel));
  assert.equal(scan.generated, 1);
  assert.equal(fs.existsSync(thumb), true);
  assert.equal(fs.statSync(original).mtimeMs, originalBefore);

  const cached = await runThumbnailScan({ uploadsDir, thumbnailsDir, logger: { info() {}, warn() {} } });
  assert.equal(cached.skippedExisting, 1);

  const orphan = path.join(thumbnailsDir, thumbnailRelPathForUpload('missing/file.jpg'));
  fs.mkdirSync(path.dirname(orphan), { recursive: true });
  fs.writeFileSync(orphan, 'orphan');
  const cleaned = await runThumbnailScan({ uploadsDir, thumbnailsDir, cleanOnly: true, logger: { info() {}, warn() {} } });
  assert.equal(cleaned.orphanDeleted, 1);
  assert.equal(fs.existsSync(orphan), false);

  fs.rmSync(tmp, { recursive: true, force: true });
});
