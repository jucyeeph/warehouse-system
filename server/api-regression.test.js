const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
