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

function assertNoUnknownUploads() {
  assert.equal(fs.existsSync(path.join(UPLOADS_DIR, 'unknown')), false, 'new uploads must not create uploads/unknown');
}

test.before(async () => {
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH, UPLOADS_DIR, PUBLIC_DIR: path.join(ROOT, 'public') },
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

test('error PO photos are isolated under Error PO Paper', async () => {
  const r = await postPhoto('/api/error', { po_code: 'POMCMP030459', worker_name: 'pc', error_description: 'import failed' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assertNoUnknownUploads();
  assert.match(listUploads().join('\n'), /^Error PO Paper\/POMCMP030459_error_/m);
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
