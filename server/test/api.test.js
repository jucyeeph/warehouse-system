const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');

async function startServer() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'warehouse-test-'));
  const port = 4100 + Math.floor(Math.random() * 1000);
  const env = {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(root, 'data', 'warehouse.db'),
    UPLOADS_DIR: path.join(root, 'data', 'uploads'),
    PUBLIC_DIR: path.resolve(__dirname, '..', '..', 'public')
  };

  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  await waitForServer(port, child, () => stdout + stderr);

  return {
    root,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    uploadsDir: env.UPLOADS_DIR,
    async stop() {
      if (!child.killed) child.kill('SIGTERM');
      await once(child, 'exit').catch(() => {});
      await fsp.rm(root, { recursive: true, force: true });
    }
  };
}

async function waitForServer(port, child, logs) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early: ${logs()}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server did not start in time: ${logs()}`);
}

async function api(server, pathname, options = {}) {
  const res = await fetch(`${server.baseUrl}${pathname}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

function imageBlob(name = 'photo.jpg') {
  return new File([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], name, { type: 'image/jpeg' });
}

test('boxes table keeps boxes when different type codes reuse sequence numbers', async () => {
  const server = await startServer();
  try {
    const upsert = await api(server, '/api/arrivals/bulk', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        box_codes: ['20260325DSH001', '20260325LCC001'],
        arrival_date: '2026-03-25',
        worker_name: 'tester'
      })
    });
    assert.equal(upsert.status, 200);

    const tableRes = await api(server, '/api/boxes/table');
    assert.equal(tableRes.status, 200);
    assert.deepEqual(tableRes.body.date_meta['20260325'].types, {
      DSH: { min: 1, max: 1, count: 1 },
      LCC: { min: 1, max: 1, count: 1 }
    });
    const cells = Object.values(tableRes.body.table['20260325'] || {});
    const codes = cells.map(c => c.box_code).sort();
    assert.deepEqual(codes, ['20260325DSH001', '20260325LCC001']);
  } finally {
    await server.stop();
  }
});

test('filesystem sync imports arrival folder and photo timestamp into database views', async () => {
  const server = await startServer();
  try {
    const folder = path.join(server.uploadsDir, '2026-04-17', '20260325LCC021');
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(
      path.join(folder, 'POMCMP026992_20260325LCC021_20260418_095818.jpg'),
      Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    );

    const poRes = await api(server, '/api/po/overview');
    assert.equal(poRes.status, 200);
    const group = poRes.body.find(g => g.arrival_date === '2026-04-17');
    assert.ok(group, 'expected synced arrival_date group');
    const po = group.pos.find(p => p.po_code === 'POMCMP026992');
    assert.ok(po, 'expected synced po_code');
    assert.equal(po.records.length, 1);
    assert.equal(po.records[0].box_code, '20260325LCC021');
    assert.equal(po.records[0].created_at, '2026-04-18 09:58:18');
  } finally {
    await server.stop();
  }
});

test('manual PO upload rejects malformed barcode text', async () => {
  const server = await startServer();
  try {
    const form = new FormData();
    form.append('po_code', '乱码123');
    form.append('box_code', '20260325LCC021');
    form.append('photo', imageBlob());

    const res = await api(server, '/api/po-record/manual', {
      method: 'POST',
      body: form
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /POMCMP/);
  } finally {
    await server.stop();
  }
});

test('editing a PO code renames the photo file and keeps database path in sync', async () => {
  const server = await startServer();
  try {
    const arrivalsRes = await api(server, '/api/arrivals/bulk', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        box_codes: ['20260325LCC021'],
        arrival_date: '2026-04-17',
        worker_name: 'tester'
      })
    });
    assert.equal(arrivalsRes.status, 200);

    const form = new FormData();
    form.append('po_code', 'POMCMP026992');
    form.append('box_code', '20260325LCC021');
    form.append('photo', imageBlob('capture.jpg'));
    const createRes = await api(server, '/api/po-record/manual', { method: 'POST', body: form });
    assert.equal(createRes.status, 200);

    const before = await api(server, '/api/po/all');
    const record = before.body.find(r => r.id === createRes.body.id);
    assert.ok(record, 'expected created po record');
    const oldPath = path.join(server.uploadsDir, record.photo_path);
    assert.ok(fs.existsSync(oldPath), 'expected original photo file to exist');

    const updateRes = await api(server, `/api/po-record/${record.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ po_code: 'POMCMP026993', notes: 'fixed' })
    });
    assert.equal(updateRes.status, 200);

    const after = await api(server, '/api/po/all');
    const updated = after.body.find(r => r.id === record.id);
    assert.equal(updated.po_code, 'POMCMP026993');
    assert.match(updated.photo_path, /POMCMP026993_/);
    assert.equal(fs.existsSync(oldPath), false, 'expected old filename to be gone after rename');
    assert.equal(fs.existsSync(path.join(server.uploadsDir, updated.photo_path)), true, 'expected renamed file to exist');
  } finally {
    await server.stop();
  }
});
