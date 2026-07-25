const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(__dirname, 'server.js');
const PORT = 32080 + Math.floor(Math.random() * 1000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-regression-'));
const DB_PATH = path.join(tmp, 'warehouse.db');
const UPLOADS_DIR = path.join(tmp, 'uploads');
let child;

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('server did not start');
}

async function postJson(url, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() };
}

async function getJson(url) {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`);
  return { status: r.status, body: await r.json() };
}

async function deleteJson(url) {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method: 'DELETE' });
  return { status: r.status, body: await r.json() };
}

async function postPhoto(url, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('photo', new Blob(['fake image bytes'], { type: 'image/jpeg' }), 'po.jpg');
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method: 'POST', body: fd });
  return { status: r.status, body: await r.json() };
}

function listUploads() {
  const files = [];
  function walk(dir, rel='') {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const r = path.join(rel, name);
      if (fs.statSync(abs).isDirectory()) walk(abs, r);
      else files.push(r.replaceAll(path.sep, '/'));
    }
  }
  walk(UPLOADS_DIR);
  return files.sort();
}

function writeUpload(relPath, content = 'fake image bytes') {
  const abs = path.join(UPLOADS_DIR, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function assertNoUnknownUploads() {
  assert.equal(fs.existsSync(path.join(UPLOADS_DIR, 'unknown')), false, 'new uploads must not create uploads/unknown');
}

test.before(async () => {
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', DISABLE_THUMBNAIL_SCANNER: '1', PORT: String(PORT), DB_PATH, UPLOADS_DIR, PUBLIC_DIR: path.join(ROOT, 'public') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => process.stdout.write(String(d)));
  child.stderr.on('data', d => process.stderr.write(String(d)));
  await waitForServer();
});

test.after(() => {
  if (child) child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('arrival rejects PO code scanned into box code field', async () => {
  const r = await postJson('/api/arrival', { box_code: 'POMCMP030456', worker_name: 'tester', arrival_date: '2026-05-15' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /PO code|box code/);
  assertNoUnknownUploads();
});

test('unboxing does not accept missing box_code and does not create unknown folder', async () => {
  const r = await postPhoto('/api/unboxing/po', { po_code: 'POMCMP030456' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /box code/);
  assertNoUnknownUploads();
});

test('unboxing rejects invalid PO code before saving a photo', async () => {
  await postJson('/api/arrival', { box_code: '20260501DSH030', worker_name: 'tester', arrival_date: '2026-05-15' });
  const r = await postPhoto('/api/unboxing/po', { box_code: '20260501DSH030', po_code: 'BAD123' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /PO code/);
  assert.deepEqual(listUploads(), []);
});

test('unboxing can补到货日期 for a valid box code and saves into date/box folder', async () => {
  const r = await postPhoto('/api/unboxing/po', { box_code: '20260501DSH031', po_code: 'POMCMP030457', arrival_date: '2026-05-15', worker_name: 'tester' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assertNoUnknownUploads();
  assert.match(listUploads().join('\n'), /^2026-05-15\/20260501DSH031\/POMCMP030457_20260501DSH031_/m);
});

test('PC no-box upload uses explicit date/No box code folder, never unknown', async () => {
  const r = await postPhoto('/api/po-record/pc', { po_code: 'POMCMP030458', arrival_date: '2026-05-15', worker_name: 'pc' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assertNoUnknownUploads();
  assert.match(listUploads().join('\n'), /^2026-05-15\/No box code\/POMCMP030458_NOBOXCODE_/m);
});

test('manual PO no-box upload stores explicit arrival date and appears in PO/error lookup', async () => {
  await postJson('/api/arrival', { box_code: '20260520DSH001', worker_name: 'receiver', arrival_date: '2026-05-20' });
  const r = await postPhoto('/api/po-record/manual', { po_code: 'POMCMP028283', arrival_date: '2026-05-20', notes: 'manual no box' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.arrival_date, '2026-05-20');
  assert.equal(r.body.photo_path.startsWith('uploads/'), false, 'photo_path must be relative to uploads root');
  assert.match(r.body.photo_path, /^2026-05-20\/No box code\/POMCMP028283_NOBOXCODE_\d{8}_\d{6}\.jpg$/);
  assert.match(listUploads().join('\n'), /^2026-05-20\/No box code\/POMCMP028283_NOBOXCODE_/m);

  const overview = await getJson('/api/po/overview?search=POMCMP028283');
  assert.equal(overview.status, 200);
  const day = overview.body.find(g => g.arrival_date === '2026-05-20');
  assert.ok(day);
  assert.ok(day.pos.find(p => p.po_code === 'POMCMP028283'));

  const err = await postPhoto('/api/error', { po_code: 'POMCMP028283', worker_name: 'qc', error_description: 'wrong item' });
  assert.equal(err.status, 200);
  const detail = await getJson(`/api/errors/${err.body.id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.po_records.find(p => p.po_code === 'POMCMP028283' && p.arrival_date === '2026-05-20'));
});

test('error record can one-click create and link a no-box PO record', async () => {
  await postJson('/api/arrival', { box_code: '20260524DSH001', worker_name: 'receiver', arrival_date: '2026-05-24' });
  const err = await postPhoto('/api/error', { po_code: 'POMCMP028286', worker_name: 'qc', error_description: 'missing manual PO' });
  assert.equal(err.status, 200);

  const created = await postJson(`/api/errors/${err.body.id}/create-po-record`, {
    po_code: 'POMCMP028286',
    arrival_date: '2026-05-24',
    notes: 'created from error'
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.success, true);
  assert.equal(created.body.arrival_date, '2026-05-24');
  assert.equal(created.body.photo_path.startsWith('uploads/'), false, 'photo_path must be relative to uploads root');
  assert.match(created.body.photo_path, /^2026-05-24\/No box code\/POMCMP028286_NOBOXCODE_\d{8}_\d{6}\.jpg$/);
  assert.match(listUploads().join('\n'), /^2026-05-24\/No box code\/POMCMP028286_NOBOXCODE_/m);

  const detail = await getJson(`/api/errors/${err.body.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.record.linked_po_record_id, created.body.po_record_id);
  assert.ok(detail.body.po_records.find(p => p.id === created.body.po_record_id && p.arrival_date === '2026-05-24'));

  const overview = await getJson('/api/po/overview?search=POMCMP028286');
  assert.equal(overview.status, 200);
  const day = overview.body.find(g => g.arrival_date === '2026-05-24');
  assert.ok(day, 'po overview should group the copied error image by selected arrival folder date');
  assert.ok(day.pos.find(p => p.po_code === 'POMCMP028286'));
});

test('error-to-PO creation rejects missing source image or non-existing arrival date without dirty rows', async () => {
  const fixtureDb = new Database(DB_PATH);
  const missing = fixtureDb.prepare(`INSERT INTO error_records (po_code, photo_path, error_description, worker_name) VALUES (?, ?, ?, ?)`)
    .run('POMCMP028287', 'Error PO Paper/missing-file.jpg', 'missing source', 'qc').lastInsertRowid;
  const beforeMissingPo = fixtureDb.prepare('SELECT COUNT(*) as c FROM po_records').get().c;
  fixtureDb.close();

  const missingResult = await postJson(`/api/errors/${missing}/create-po-record`, { po_code: 'POMCMP028287', arrival_date: '2026-05-24' });
  assert.equal(missingResult.status, 400);
  assert.match(missingResult.body.error, /图片源文件不存在/);

  let checkDb = new Database(DB_PATH);
  assert.equal(checkDb.prepare('SELECT COUNT(*) as c FROM po_records').get().c, beforeMissingPo);
  assert.equal(checkDb.prepare('SELECT linked_po_record_id FROM error_records WHERE id=?').get(missing).linked_po_record_id, null);
  checkDb.close();

  const err = await postPhoto('/api/error', { po_code: 'POMCMP028288', worker_name: 'qc', error_description: 'bad date' });
  assert.equal(err.status, 200);
  checkDb = new Database(DB_PATH);
  const beforeBadDatePo = checkDb.prepare('SELECT COUNT(*) as c FROM po_records').get().c;
  checkDb.close();

  const badDate = await postJson(`/api/errors/${err.body.id}/create-po-record`, { po_code: 'POMCMP028288', arrival_date: '2099-01-01' });
  assert.equal(badDate.status, 400);
  assert.match(badDate.body.error, /到货日期不存在|已有到货日期/);

  checkDb = new Database(DB_PATH);
  assert.equal(checkDb.prepare('SELECT COUNT(*) as c FROM po_records').get().c, beforeBadDatePo);
  assert.equal(checkDb.prepare('SELECT linked_po_record_id FROM error_records WHERE id=?').get(err.body.id).linked_po_record_id, null);
  checkDb.close();
  assert.equal(listUploads().some(f => f.includes('POMCMP028288_NOBOXCODE')), false);
});

test('PO overview and lookups prefer the upload folder date over cached DB arrival_date', async () => {
  const fixtureDb = new Database(DB_PATH);
  fixtureDb.prepare(`INSERT INTO po_records (box_code, arrival_date, po_code, photo_path, notes)
    VALUES ('', ?, ?, ?, ?)`)
    .run('2026-05-19', 'POMCMP028284', '2026-05-20/No box code/POMCMP028284_NOBOXCODE_20260523_183000.jpg', 'stale cached date');
  fixtureDb.prepare(`INSERT INTO po_records (box_code, arrival_date, po_code, photo_path, notes)
    VALUES ('', NULL, ?, ?, ?)`)
    .run('POMCMP028285', '2026-05-20/No box code/POMCMP028285_NOBOXCODE_20260523_183001.jpg', 'missing cached date');
  fixtureDb.close();

  const overview = await getJson('/api/po/overview?search=POMCMP02828');
  assert.equal(overview.status, 200);
  const day = overview.body.find(g => g.arrival_date === '2026-05-20');
  assert.ok(day, 'overview should group by the first YYYY-MM-DD photo_path folder');
  assert.ok(day.pos.find(p => p.po_code === 'POMCMP028284'));
  assert.ok(day.pos.find(p => p.po_code === 'POMCMP028285'));
  assert.equal(overview.body.some(g => g.arrival_date === '2026-05-19' && g.pos.some(p => p.po_code === 'POMCMP028284')), false);

  const all = await getJson('/api/po/all?search=POMCMP028284');
  assert.equal(all.status, 200);
  assert.equal(all.body[0].arrival_date, '2026-05-20');

  const err = await postPhoto('/api/error', { po_code: 'POMCMP028284', worker_name: 'qc', error_description: 'folder date lookup' });
  assert.equal(err.status, 200);
  const detail = await getJson(`/api/errors/${err.body.id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.po_records.find(p => p.po_code === 'POMCMP028284' && p.arrival_date === '2026-05-20'));
});

test('fs-sync preview scans folder PO images without writing DB and reports exceptions', async () => {
  writeUpload('2026-05-20/No box code/POMCMP028301_NOBOXCODE_20260520_144644.jpg');
  writeUpload('2026-05-20/No box code/POMCMPFSB001_NOBOXCODE_20260520_120000.jpg');
  writeUpload('2026-05-20/20260520DSH001/POMCMPFSB002_20260520DSH001_20260520_120001.jpg');
  writeUpload('2026-05-20/No box code/BADNAME_20260520_120002.jpg');
  writeUpload('2026-05-20/No box code/BAD_NOBOXCODE_20260520_144644.jpg');
  writeUpload('not-a-date/No box code/POMCMP028399_NOBOXCODE_20260520_144644.jpg');
  writeUpload('Error PO Paper/POMCMP028398_error_20260520_144644.jpg');

  const beforeDb = new Database(DB_PATH);
  const beforePo = beforeDb.prepare('SELECT COUNT(*) as c FROM po_records WHERE photo_path=?').get('2026-05-20/No box code/POMCMP028301_NOBOXCODE_20260520_144644.jpg').c;
  beforeDb.close();

  const preview = await getJson('/api/fs-sync/po-preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.success, true);
  assert.ok(preview.body.records.find(r => r.photo_path === '2026-05-20/No box code/POMCMP028301_NOBOXCODE_20260520_144644.jpg'));
  assert.equal(preview.body.records.find(r => r.photo_path === '2026-05-20/No box code/POMCMPFSB001_NOBOXCODE_20260520_120000.jpg')?.po_code, 'POMCMPFSB001');
  assert.equal(preview.body.records.find(r => r.photo_path === '2026-05-20/20260520DSH001/POMCMPFSB002_20260520DSH001_20260520_120001.jpg')?.po_code, 'POMCMPFSB002');
  assert.ok(preview.body.unrecognized_files.find(r => r.photo_path === '2026-05-20/No box code/BADNAME_20260520_120002.jpg'));
  assert.ok(preview.body.unrecognized_files.find(r => r.photo_path === '2026-05-20/No box code/BAD_NOBOXCODE_20260520_144644.jpg'));
  assert.equal(preview.body.records.some(r => r.photo_path.includes('not-a-date')), false);
  assert.equal(preview.body.records.some(r => r.photo_path.startsWith('Error PO Paper/')), false);
  assert.ok(preview.body.error_records.find(r => r.photo_path === 'Error PO Paper/POMCMP028398_error_20260520_144644.jpg'));
  assert.equal(preview.body.error_records.find(r => r.photo_path === 'Error PO Paper/POMCMP028398_error_20260520_144644.jpg').created_at, '2026-05-20 14:46:44');

  const afterDb = new Database(DB_PATH);
  assert.equal(afterDb.prepare('SELECT COUNT(*) as c FROM po_records WHERE photo_path=?').get('2026-05-20/No box code/POMCMP028301_NOBOXCODE_20260520_144644.jpg').c, beforePo, 'preview must not write DB');
  afterDb.close();
});

test('fs-sync apply indexes Error PO Paper images into error records', async () => {
  const rel = 'Error PO Paper/POMCMP030461_error_20260513_141440.jpg';
  writeUpload(rel);

  const preview = await getJson('/api/fs-sync/po-preview');
  assert.equal(preview.status, 200);
  assert.ok(preview.body.error_records.find(r => r.photo_path === rel));

  const applied = await postJson('/api/fs-sync/po-apply', {});
  assert.equal(applied.status, 200);
  assert.equal(applied.body.success, true);
  assert.ok(applied.body.inserted_error_records >= 1);

  const checkDb = new Database(DB_PATH);
  const row = checkDb.prepare('SELECT po_code, photo_path, created_at, review_status FROM error_records WHERE photo_path=?').get(rel);
  assert.equal(row.po_code, 'POMCMP030461');
  assert.equal(row.created_at, '2026-05-13 14:14:40');
  assert.equal(row.review_status, 'pending');
  checkDb.close();
});

test('error folder alignment treats Error PO Paper as source of truth including Solved', async () => {
  const activeRel = 'Error PO Paper/POMCMP030463_error_20260513_141440.jpg';
  const solvedRel = 'Error PO Paper/Solved/solved_20260513_151500《POMCMP030464_20260501DSH029_20260513_101337.jpg》.jpg';
  const staleRel = 'Error PO Paper/POMCMP030465_error_20260510_090000.jpg';
  writeUpload(activeRel);
  writeUpload(solvedRel);

  const fixtureDb = new Database(DB_PATH);
  fixtureDb.prepare(`INSERT INTO error_records (po_code, photo_path, review_status, created_at, worker_name)
    VALUES (?, ?, ?, ?, ?)`).run('POMCMP030464', staleRel, 'pending', '2026-05-01 00:00:00', 'old-index');
  fixtureDb.prepare(`INSERT INTO error_records (po_code, photo_path, review_status, created_at, worker_name)
    VALUES (?, ?, ?, ?, ?)`).run('POMCMP030466', 'Error PO Paper/POMCMP030466_error_20260510_090000.jpg', 'pending', '2026-05-10 09:00:00', 'old-index');
  fixtureDb.close();

  const preview = await getJson('/api/fs-sync/errors-preview');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.success, true);
  assert.ok(preview.body.to_add >= 1);
  assert.ok(preview.body.to_update >= 1);
  assert.ok(preview.body.to_remove >= 1);

  const aligned = await postJson('/api/fs-sync/errors-apply', {});
  assert.equal(aligned.status, 200);
  assert.equal(aligned.body.success, true);

  const checkDb = new Database(DB_PATH);
  const active = checkDb.prepare('SELECT po_code, review_status, created_at FROM error_records WHERE photo_path=?').get(activeRel);
  assert.equal(active.po_code, 'POMCMP030463');
  assert.equal(active.review_status, 'pending');
  assert.equal(active.created_at, '2026-05-13 14:14:40');
  const solved = checkDb.prepare('SELECT po_code, review_status, created_at FROM error_records WHERE photo_path=?').get(solvedRel);
  assert.equal(solved.po_code, 'POMCMP030464');
  assert.equal(solved.review_status, 'resolved');
  assert.equal(solved.created_at, '2026-05-13 15:15:00');
  assert.equal(checkDb.prepare('SELECT COUNT(*) as c FROM error_records WHERE photo_path=?').get(staleRel).c, 0);
  assert.equal(checkDb.prepare('SELECT COUNT(*) as c FROM error_records WHERE po_code=?').get('POMCMP030466').c, 0);
  checkDb.close();
});

test('fs-sync apply inserts no-box PO records and skips duplicate photo_path', async () => {
  const rel = '2026-05-20/No box code/POMCMP028302_NOBOXCODE_20260520_144644.png';
  writeUpload(rel);

  const applied = await postJson('/api/fs-sync/po-apply', {});
  assert.equal(applied.status, 200);
  assert.equal(applied.body.success, true);
  assert.ok(applied.body.inserted_po_records >= 1);

  let checkDb = new Database(DB_PATH);
  assert.equal(checkDb.prepare('SELECT COUNT(*) as c FROM po_records WHERE photo_path=?').get(rel).c, 1);
  checkDb.close();

  const again = await getJson('/api/fs-sync/po-preview');
  assert.equal(again.status, 200);
  assert.ok(again.body.duplicate_files.find(r => r.photo_path === rel));
  const appliedAgain = await postJson('/api/fs-sync/po-apply', {});
  assert.equal(appliedAgain.status, 200);
  checkDb = new Database(DB_PATH);
  assert.equal(checkDb.prepare('SELECT COUNT(*) as c FROM po_records WHERE photo_path=?').get(rel).c, 1, 'same photo_path must not be inserted twice');
  checkDb.close();
});

test('fs-sync apply supplements missing arrivals for boxed folders and respects folder date in PO manager', async () => {
  const rel = '2026-05-21/20260521DSH901（临时备注）/POMCMP028303_20260521DSH901_20260521_144644.WEBP';
  writeUpload(rel);

  const preview = await getJson('/api/fs-sync/po-preview');
  assert.equal(preview.status, 200);
  const row = preview.body.records.find(r => r.photo_path === rel);
  assert.equal(row.box_code, '20260521DSH901');
  assert.equal(row.arrival_action, 'create');

  const applied = await postJson('/api/fs-sync/po-apply', {});
  assert.equal(applied.status, 200);

  const checkDb = new Database(DB_PATH);
  const arrival = checkDb.prepare('SELECT arrival_date, worker_name FROM arrivals WHERE box_code=?').get('20260521DSH901');
  assert.equal(arrival.arrival_date, '2026-05-21');
  assert.equal(arrival.worker_name, '文件夹同步');
  checkDb.close();

  const overview = await getJson('/api/po/overview?search=POMCMP028303');
  assert.ok(overview.body.find(g => g.arrival_date === '2026-05-21')?.pos.find(p => p.po_code === 'POMCMP028303'));
});

test('fs-sync updates empty arrival dates but warns and preserves conflicting arrival dates', async () => {
  const fixtureDb = new Database(DB_PATH);
  fixtureDb.prepare('INSERT INTO arrivals (box_code, arrival_date, worker_name) VALUES (?, ?, ?)').run('20260522DSH901', null, 'receiver');
  fixtureDb.prepare('INSERT INTO arrivals (box_code, arrival_date, worker_name) VALUES (?, ?, ?)').run('20260522DSH902', '2026-05-19', 'receiver');
  fixtureDb.close();
  writeUpload('2026-05-22/20260522DSH901/POMCMP028304_20260522DSH901_20260522_144644.heic');
  writeUpload('2026-05-22/20260522DSH902/POMCMP028305_20260522DSH902_20260522_144644.heif');

  const preview = await getJson('/api/fs-sync/po-preview');
  assert.equal(preview.body.records.find(r => r.po_code === 'POMCMP028304').arrival_action, 'update_empty');
  assert.ok(preview.body.warnings.find(w => w.box_code === '20260522DSH902'));

  const applied = await postJson('/api/fs-sync/po-apply', {});
  assert.equal(applied.status, 200);
  const checkDb = new Database(DB_PATH);
  assert.equal(checkDb.prepare('SELECT arrival_date FROM arrivals WHERE box_code=?').get('20260522DSH901').arrival_date, '2026-05-22');
  assert.equal(checkDb.prepare('SELECT arrival_date FROM arrivals WHERE box_code=?').get('20260522DSH902').arrival_date, '2026-05-19');
  checkDb.close();
});

test('fs-sync apply rolls back transaction on failure', async () => {
  const rel = '2026-05-23/20260523DSH901/POMCMP028306_20260523DSH901_20260523_144644.jpg';
  writeUpload(rel);
  const failed = await postJson('/api/fs-sync/po-apply', { simulate_error: true });
  assert.equal(failed.status, 500);
  assert.match(failed.body.error, /Simulated fs-sync failure/);

  const checkDb = new Database(DB_PATH);
  assert.equal(checkDb.prepare('SELECT COUNT(*) as c FROM po_records WHERE photo_path=?').get(rel).c, 0);
  assert.equal(checkDb.prepare('SELECT COUNT(*) as c FROM arrivals WHERE box_code=?').get('20260523DSH901').c, 0);
  checkDb.close();
});

test('error PO photos are isolated under Error PO Paper', async () => {
  const r = await postPhoto('/api/error', { po_code: 'POMCMP030459', worker_name: 'pc', error_description: 'import failed' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assertNoUnknownUploads();
  assert.match(listUploads().join('\n'), /^Error PO Paper\/POMCMP030459_error_/m);
  const checkDb = new Database(DB_PATH);
  const row = checkDb.prepare('SELECT photo_path, created_at FROM error_records WHERE id=?').get(r.body.id);
  assert.equal(row.created_at, row.photo_path.match(/_(\d{8})_(\d{6})/)[1].replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') + ' ' + row.photo_path.match(/_(\d{8})_(\d{6})/)[2].replace(/(\d{2})(\d{2})(\d{2})/, '$1:$2:$3'));
  checkDb.close();
});

test('resolved error records are renamed and archived under Error PO Paper/Solved', async () => {
  await postJson('/api/arrival', { box_code: '20260525DSH001', worker_name: 'receiver', arrival_date: '2026-05-25' });
  const err = await postPhoto('/api/error', { po_code: 'POMCMP030462', worker_name: 'qc', error_description: 'archive me' });
  assert.equal(err.status, 200);

  const created = await postJson(`/api/errors/${err.body.id}/create-po-record`, {
    po_code: 'POMCMP030462',
    arrival_date: '2026-05-25',
    notes: 'created for archive'
  });
  assert.equal(created.status, 200);

  const reviewed = await fetch(`http://127.0.0.1:${PORT}/api/errors/${err.body.id}/review`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ review_status: 'resolved', review_notes: 'done', reviewed_by: 'tester' })
  });
  const reviewedBody = await reviewed.json();
  assert.equal(reviewed.status, 200);
  assert.equal(reviewedBody.archived, true);
  assert.match(reviewedBody.photo_path, /^Error PO Paper\/Solved\/solved_\d{8}_\d{6}《POMCMP030462_NOBOXCODE_\d{8}_\d{6}\.jpg》\.jpg$/);
  assert.equal(fs.existsSync(path.join(UPLOADS_DIR, reviewedBody.photo_path)), true);

  const checkDb = new Database(DB_PATH);
  const row = checkDb.prepare('SELECT review_status, photo_path FROM error_records WHERE id=?').get(err.body.id);
  assert.equal(row.review_status, 'resolved');
  assert.equal(row.photo_path, reviewedBody.photo_path);
  checkDb.close();
});

test('resolved review archives from folder source when DB path is stale', async () => {
  const activeRel = 'Error PO Paper/POMCMP030467_error_20260513_161700.jpg';
  writeUpload(activeRel);
  const fixtureDb = new Database(DB_PATH);
  const id = fixtureDb.prepare(`INSERT INTO error_records (po_code, photo_path, review_status, created_at, worker_name)
    VALUES (?, ?, ?, ?, ?)`).run('POMCMP030467', 'Error PO Paper/missing_20260513_161700.jpg', 'reviewed', '2026-05-01 00:00:00', 'old-index').lastInsertRowid;
  fixtureDb.close();

  const reviewed = await fetch(`http://127.0.0.1:${PORT}/api/errors/${id}/review`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ review_status: 'resolved', review_notes: 'done', reviewed_by: 'tester' })
  });
  const reviewedBody = await reviewed.json();
  assert.equal(reviewed.status, 200);
  assert.equal(reviewedBody.archived, true);
  assert.equal(fs.existsSync(path.join(UPLOADS_DIR, activeRel)), false);
  assert.equal(fs.existsSync(path.join(UPLOADS_DIR, reviewedBody.photo_path)), true);

  const checkDb = new Database(DB_PATH);
  const row = checkDb.prepare('SELECT review_status, photo_path, created_at FROM error_records WHERE id=?').get(id);
  assert.equal(row.review_status, 'resolved');
  assert.equal(row.photo_path, reviewedBody.photo_path);
  assert.equal(row.created_at, '2026-05-13 16:17:00');
  checkDb.close();
});

test('PC no-box and no-PO upload saves NOPO evidence under date/No box code', async () => {
  const r = await postPhoto('/api/po-record/pc', {
    arrival_date: '2026-05-15',
    no_po_reason: 'Hand count',
    worker_name: 'pc'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assertNoUnknownUploads();
  assert.match(listUploads().join('\n'), /^2026-05-15\/No box code\/NOPO_NOBOXCODE_.*（Hand count）\.jpg$/m);
});

test('unboxing can use a selected arrived box when the box code is unreadable during unboxing', async () => {
  await postJson('/api/arrival', { box_code: '20260501DSH040', worker_name: 'receiver', arrival_date: '2026-05-15' });
  const r = await postPhoto('/api/unboxing/po', {
    selected_box_code: '20260501DSH040',
    po_code: 'POMCMP030460',
    worker_name: 'unboxer'
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assertNoUnknownUploads();
  assert.match(listUploads().join('\n'), /^2026-05-15\/20260501DSH040\/POMCMP030460_20260501DSH040_/m);
});

test('shipment batch can be revoked and re-submitted with the same box codes', async () => {
  const payload = { shipment_date: '2026-05-21', total_count: 2, items: [{ type_code: 'DSH', count: 2 }], operator: 'tester' };
  const first = await postJson('/api/shipments/batch', payload);
  assert.equal(first.status, 200);
  assert.equal(first.body.success, true);

  const revoked = await deleteJson(`/api/shipments/batches/${first.body.batch_id}`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.success, true);

  const second = await postJson('/api/shipments/batch', payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.success, true);

  const overview = await getJson('/api/shipments/overview');
  const day = overview.body.find(d => d.shipment_date === '20260521');
  assert.equal(day.total, 2);
  assert.deepEqual(day.boxes.map(b => b.box_code), ['20260521DSH001', '20260521DSH002']);

  const table = await getJson('/api/boxes/table');
  assert.equal(table.body.date_meta['20260521'].shipped_count, 2);
});

test('shipment batch rejects duplicate box codes while an active batch exists', async () => {
  const payload = { shipment_date: '2026-05-22', total_count: 1, items: [{ type_code: 'DSH', count: 1 }], operator: 'tester' };
  const first = await postJson('/api/shipments/batch', payload);
  assert.equal(first.status, 200);

  const duplicate = await postJson('/api/shipments/batch', payload);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /未撤回|箱号已存在/);
});

test('shipment segments preserve split supplier order in overview and table metadata', async () => {
  const payload = {
    shipment_date: '2026-05-23',
    total_count: 30,
    items: [
      { type_code: 'DSH', count: 26 },
      { type_code: 'LCC', count: 3 },
      { type_code: 'DSH', count: 1 }
    ],
    operator: 'tester'
  };
  const r = await postJson('/api/shipments/batch', payload);
  assert.equal(r.status, 200);

  const overview = await getJson('/api/shipments/overview');
  const day = overview.body.find(d => d.shipment_date === '20260523');
  assert.deepEqual(day.segments.map(s => `${s.type_code}:${s.count}:${s.start_seq}-${s.end_seq}`), [
    'DSH:26:1-26',
    'LCC:3:27-29',
    'DSH:1:30-30'
  ]);

  const table = await getJson('/api/boxes/table');
  assert.deepEqual(table.body.date_meta['20260523'].segments.map(s => `${s.type_code}:${s.count}`), ['DSH:26', 'LCC:3', 'DSH:1']);
});

test('box table uses gzip when the client supports it', async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/boxes/table`, {
    headers: { 'Accept-Encoding': 'gzip' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.match(response.headers.get('vary') || '', /Accept-Encoding/i);
  const body = await response.json();
  assert.ok(Array.isArray(body.shipment_dates));
});

test('bulk clear arrivals removes selected boxes and returns them to in-transit table state', async () => {
  const payload = {
    shipment_date: '2026-05-25',
    total_count: 3,
    items: [{ type_code: 'DSH', count: 3 }],
    operator: 'tester'
  };
  const shipped = await postJson('/api/shipments/batch', payload);
  assert.equal(shipped.status, 200);

  const bulk = await fetch(`http://127.0.0.1:${PORT}/api/arrivals/bulk`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      box_codes: ['20260525DSH001', '20260525DSH002'],
      arrival_date: '2026-06-01',
      worker_name: 'tester'
    })
  });
  assert.equal(bulk.status, 200);

  const cleared = await fetch(`http://127.0.0.1:${PORT}/api/arrivals/bulk-clear`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ box_codes: ['20260525DSH001', '20260525DSH002'] })
  });
  const body = await cleared.json();
  assert.equal(cleared.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.deleted, 2);

  const table = await getJson('/api/boxes/table');
  assert.equal(table.body.table['20260525'][1].arrived, false);
  assert.equal(table.body.table['20260525'][2].arrived, false);
  assert.equal(table.body.date_meta['20260525'].remaining_count, 3);
});
