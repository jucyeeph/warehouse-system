const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './data/warehouse.db';
const UPLOADS_DIR = process.env.UPLOADS_DIR || './data/uploads';
const PUBLIC_DIR = process.env.PUBLIC_DIR || '/public';

if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function parseBoxCode(code) {
  const m = String(code).trim().toUpperCase().match(/^(\d{8})([A-Z0-9]+?)(\d{3})$/);
  if (!m) return null;
  return { date: m[1], type: m[2].toUpperCase(), seq: parseInt(m[3], 10) };
}
function fmtShipDate(d) {
  if (!d || d.length < 8) return d;
  return `${d.slice(0,4)}年${parseInt(d.slice(4,6))}月${parseInt(d.slice(6,8))}日`;
}
function fmtArrDate(d) {
  if (!d || d.length < 10) return d || '—';
  const [y,m,day] = d.split('-');
  return `${y}年${parseInt(m)}月${parseInt(day)}日`;
}

function normalizeShipmentDate(input) {
  const s = String(input || '').trim().replace(/[\/.]/g, '-');
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y,m,d] = s.split('-');
    return `${y}${String(m).padStart(2,'0')}${String(d).padStart(2,'0')}`;
  }
  if (/^\d{8}$/.test(s)) return s;
  return null;
}
function displayShipmentDate(ymd8) {
  if (!ymd8 || ymd8.length !== 8) return ymd8 || '—';
  return `${ymd8.slice(0,4)}-${ymd8.slice(4,6)}-${ymd8.slice(6,8)}`;
}
function buildShipmentCodes(shipmentDateRaw, items) {
  const shipment_date = normalizeShipmentDate(shipmentDateRaw);
  if (!shipment_date) throw new Error('发货日期格式错误');
  if (!Array.isArray(items) || !items.length) throw new Error('请至少填写一个代号');
  const boxes = [];
  let seq = 1;
  let segment_no = 1;
  for (const item of items) {
    const type_code = String(item.type_code || item.code || '').trim().toUpperCase();
    const count = parseInt(item.count, 10);
    if (!type_code) throw new Error('存在空代号');
    if (!/^[A-Z0-9]+$/.test(type_code)) throw new Error(`代号格式错误：${type_code}`);
    if (!Number.isInteger(count) || count <= 0) throw new Error(`箱数错误：${type_code}`);
    for (let i=0;i<count;i++) {
      boxes.push({
        shipment_date,
        type_code,
        seq_no: seq,
        box_code: `${shipment_date}${type_code}${String(seq).padStart(3,'0')}`,
        segment_no,
        segment_seq: i + 1
      });
      seq++;
    }
    segment_no++;
  }
  return { shipment_date, total_count: boxes.length, boxes };
}

// ── DB ────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS arrivals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    box_code TEXT NOT NULL UNIQUE,
    worker_name TEXT,
    notes TEXT,
    arrival_date TEXT,
    unboxed_at TEXT,
    scanned_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS unboxing_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    box_code TEXT NOT NULL,
    worker_name TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS po_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES unboxing_sessions(id),
    box_code TEXT NOT NULL DEFAULT '',
    arrival_date TEXT,
    po_code TEXT NOT NULL,
    photo_path TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS error_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    box_code TEXT DEFAULT '',
    po_code TEXT NOT NULL,
    photo_path TEXT,
    error_description TEXT,
    worker_name TEXT,
    review_status TEXT DEFAULT 'pending',
    review_notes TEXT,
    reviewed_by TEXT,
    reviewed_at TEXT,
    linked_group TEXT,
    linked_po_record_id INTEGER REFERENCES po_records(id),
    created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS import_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    imported_codes TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    skip_dup INTEGER DEFAULT 1,
    operator TEXT DEFAULT '管理员',
    created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS shipment_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_date TEXT NOT NULL,
    total_count INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL,
    operator TEXT DEFAULT '管理员',
    revoked_at TEXT,
    revoked_by TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS shipment_boxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES shipment_batches(id) ON DELETE CASCADE,
    shipment_date TEXT NOT NULL,
    type_code TEXT NOT NULL,
    seq_no INTEGER NOT NULL,
    box_code TEXT NOT NULL,
    segment_no INTEGER NOT NULL DEFAULT 0,
    segment_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_arrivals_box  ON arrivals(box_code);
  CREATE INDEX IF NOT EXISTS idx_arrivals_date ON arrivals(arrival_date);
  CREATE INDEX IF NOT EXISTS idx_po_box        ON po_records(box_code);
  CREATE INDEX IF NOT EXISTS idx_po_code       ON po_records(po_code);
  CREATE INDEX IF NOT EXISTS idx_err_po        ON error_records(po_code);
  CREATE INDEX IF NOT EXISTS idx_err_status    ON error_records(review_status);
  CREATE INDEX IF NOT EXISTS idx_ship_box      ON shipment_boxes(box_code);
  CREATE INDEX IF NOT EXISTS idx_ship_date     ON shipment_boxes(shipment_date);
`);
[
  'ALTER TABLE arrivals ADD COLUMN arrival_date TEXT',
  'ALTER TABLE arrivals ADD COLUMN unboxed_at TEXT',
  'ALTER TABLE error_records ADD COLUMN linked_po_record_id INTEGER',
  "ALTER TABLE po_records ADD COLUMN box_code TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE po_records ADD COLUMN arrival_date TEXT',
].forEach(sql => { try { db.exec(sql); } catch {} });
try { db.exec('CREATE INDEX IF NOT EXISTS idx_po_arrival ON po_records(arrival_date)'); } catch {}


function hasUniqueShipmentBoxCodeIndex() {
  const indexes = db.prepare("PRAGMA index_list('shipment_boxes')").all();
  return indexes.some(idx => {
    if (!idx.unique) return false;
    const cols = db.prepare(`PRAGMA index_info(${JSON.stringify(idx.name)})`).all().map(c => c.name);
    return cols.length === 1 && cols[0] === 'box_code';
  });
}
function ensureShipmentBoxesSchema() {
  const cols = db.prepare("PRAGMA table_info('shipment_boxes')").all().map(c => c.name);
  const needsRebuild = hasUniqueShipmentBoxCodeIndex() || !cols.includes('segment_no') || !cols.includes('segment_seq');
  if (!needsRebuild) return;
  const hasSegmentNo = cols.includes('segment_no');
  const hasSegmentSeq = cols.includes('segment_seq');
  const segmentNoExpr = hasSegmentNo ? 'segment_no' : '0';
  const segmentSeqExpr = hasSegmentSeq ? 'segment_seq' : '0';
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE shipment_boxes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id INTEGER NOT NULL REFERENCES shipment_batches(id) ON DELETE CASCADE,
          shipment_date TEXT NOT NULL,
          type_code TEXT NOT NULL,
          seq_no INTEGER NOT NULL,
          box_code TEXT NOT NULL,
          segment_no INTEGER NOT NULL DEFAULT 0,
          segment_seq INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now','localtime'))
        );
        INSERT INTO shipment_boxes_new (id,batch_id,shipment_date,type_code,seq_no,box_code,segment_no,segment_seq,created_at)
        SELECT id,batch_id,shipment_date,type_code,seq_no,box_code,${segmentNoExpr},${segmentSeqExpr},created_at FROM shipment_boxes;
        DROP TABLE shipment_boxes;
        ALTER TABLE shipment_boxes_new RENAME TO shipment_boxes;
        CREATE INDEX IF NOT EXISTS idx_ship_box      ON shipment_boxes(box_code);
        CREATE INDEX IF NOT EXISTS idx_ship_date     ON shipment_boxes(shipment_date);
        CREATE INDEX IF NOT EXISTS idx_ship_batch    ON shipment_boxes(batch_id);
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
function isSqliteConstraintError(err) {
  return err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || String(err.message || '').includes('constraint failed'));
}
ensureShipmentBoxesSchema();

function sanitizeCodeSegment(value, fallback='unknown') {
  const sanitized = String(value || '').trim().replace(/[^a-zA-Z0-9_\-]/g, '_');
  return sanitized || fallback;
}
function sanitizeFolderSegment(value, fallback='未备注') {
  const sanitized = String(value || '').trim().replace(/[\\/]+/g, '、').replace(/[\r\n]+/g, ' ').replace(/[:*?"<>|]/g, '_').replace(/\s+/g, ' ');
  return sanitized || fallback;
}
function normalizeArrivalDate(input) {
  const s = String(input || '').trim().replace(/[\/.]/g, '-');
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  return null;
}
function arrivalDateFromPhotoPath(photoPath) {
  const firstSegment = String(photoPath || '').split(/[\\/]+/).find(Boolean);
  if (!firstSegment || !/^\d{4}-\d{2}-\d{2}$/.test(firstSegment)) return null;
  return normalizeArrivalDate(firstSegment);
}
function resolvePoArrivalDate(row) {
  return arrivalDateFromPhotoPath(row?.photo_path)
    || normalizeArrivalDate(row?.arrival_date)
    || normalizeArrivalDate(row?.box_arrival_date)
    || normalizeArrivalDate(row?.group_arrival_date)
    || null;
}
function normalizePoCode(input) { return String(input || '').trim().toUpperCase(); }
function isValidPoCode(input) { return /^POMCMP\d{6}$/.test(normalizePoCode(input)); }
function looksLikePoCode(input) { return /^POMCMP/i.test(String(input || '').trim()); }
function isValidBoxCode(input) {
  const code = String(input || '').trim().toUpperCase();
  if (!/^(\d{8})([A-Z0-9]+?)(\d{3})$/.test(code)) return false;
  const d = code.slice(0, 8);
  const iso = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
  return normalizeArrivalDate(iso) === iso;
}
function assertValidBoxCode(boxCode) {
  if (!boxCode) throw new Error('Missing box code.');
  if (looksLikePoCode(boxCode)) throw new Error('You scanned a PO code, not a box code. Please scan the box QR code.');
  if (!isValidBoxCode(boxCode)) throw new Error('Invalid box code format. Please rescan or contact the supervisor.');
}
function assertValidPoCode(poCode) {
  if (!isValidPoCode(poCode)) throw new Error('Invalid PO code. Please rescan or type it manually. Format: POMCMP + 6 digits.');
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function ensureArrivalUploadDir(boxCode, arrivalDate, folderRemark='') {
  const safeBox = sanitizeCodeSegment(boxCode, 'NOBOXCODE');
  const safeDate = normalizeArrivalDate(arrivalDate);
  if (!safeDate) throw new Error('Missing valid arrival date. Cannot save to unknown.');
  const folder = folderRemark ? `${safeBox}（${sanitizeFolderSegment(folderRemark)}）` : safeBox;
  return ensureDir(path.join(UPLOADS_DIR, safeDate, folder));
}
function ensureNoBoxUploadDir(arrivalDate) {
  const safeDate = normalizeArrivalDate(arrivalDate);
  if (!safeDate) throw new Error('Missing valid arrival date. Cannot save to unknown.');
  return ensureDir(path.join(UPLOADS_DIR, safeDate, 'No box code'));
}
function resolveUploadPath(relPath) {
  const uploadRoot = path.resolve(UPLOADS_DIR);
  const resolved = path.resolve(uploadRoot, String(relPath || ''));
  if (resolved !== uploadRoot && resolved.startsWith(uploadRoot + path.sep)) return resolved;
  throw new Error('Invalid photo path');
}
function assertExistingArrivalDate(adate) {
  const safeDate = normalizeArrivalDate(adate);
  if (!safeDate) throw new Error('请选择有效到货日期');
  const exists = db.prepare('SELECT 1 FROM arrivals WHERE arrival_date=? LIMIT 1').get(safeDate);
  if (!exists) throw new Error('到货日期不存在，请从已有到货日期中选择');
  return safeDate;
}
function buildNoBoxPoPhotoPath(poCode, arrivalDate) {
  const finalPo = normalizePoCode(poCode);
  assertValidPoCode(finalPo);
  const safeDate = normalizeArrivalDate(arrivalDate);
  if (!safeDate) throw new Error('请选择有效到货日期');
  const dir = ensureNoBoxUploadDir(safeDate);
  const filename = `${sanitizeCodeSegment(finalPo, 'NOPO')}_NOBOXCODE_${buildPhotoStamp()}.jpg`;
  return { absPath: path.join(dir, filename), relPath: `${safeDate}/No box code/${filename}` };
}
function getPhotoExt(req) {
  return path.extname(req.file?.originalname || req.body.originalname || '').toLowerCase() || '.jpg';
}
function getNoPoRemark(req) {
  return sanitizeFolderSegment(req.body.no_po_reason || req.body.notes || '未填写采购单码');
}
function ensureArrivalForUpload(boxCode, arrivalDate, workerName) {
  assertValidBoxCode(boxCode);
  let arrival = db.prepare('SELECT id, arrival_date FROM arrivals WHERE box_code=? ORDER BY id DESC LIMIT 1').get(boxCode);
  if (arrival?.arrival_date) return normalizeArrivalDate(arrival.arrival_date);
  const adate = normalizeArrivalDate(arrivalDate);
  if (!adate) throw new Error('This box has no arrival record. Please choose an arrival date first.');
  if (arrival?.id) db.prepare('UPDATE arrivals SET arrival_date=? WHERE id=?').run(adate, arrival.id);
  else db.prepare('INSERT INTO arrivals (box_code,arrival_date,worker_name) VALUES(?,?,?)').run(boxCode, adate, workerName || '开箱补登记');
  ensureArrivalUploadDir(boxCode, adate);
  return adate;
}
function resolvePoUploadMeta(req, { allowArrivalDateFallback=false } = {}) {
  const ext = getPhotoExt(req);
  const po = normalizePoCode(req.body.po_code);
  const hasPo = Boolean(po);
  const isNoPo = !hasPo && Boolean(req.body.no_po_reason || req.body.notes);
  if (hasPo) assertValidPoCode(po);
  if (!hasPo && !isNoPo) throw new Error('Missing PO code. If there is no PO paper, select a reason.');

  const submittedBoxCode = req.body.box_code || req.body.selected_box_code;
  if (submittedBoxCode) {
    const boxCode = String(submittedBoxCode).trim().toUpperCase();
    const adate = ensureArrivalForUpload(boxCode, req.body.arrival_date, req.body.worker_name);
    const rawBox = sanitizeCodeSegment(boxCode, 'NOBOXCODE');
    const remark = isNoPo ? getNoPoRemark(req) : '';
    const relFolder = remark ? `${rawBox}（${remark}）` : rawBox;
    const filePo = hasPo ? sanitizeCodeSegment(po, 'NOPO') : 'NOPO';
    const suffix = isNoPo ? `（${remark}）` : '';
    return {
      rawPo: filePo, rawBox, rawDate: adate, relDir: `${adate}/${relFolder}`,
      absDir: ensureArrivalUploadDir(boxCode, adate, remark),
      filename: `${filePo}_${rawBox}_${buildPhotoStamp()}${suffix}${ext}`
    };
  }

  if (!allowArrivalDateFallback) throw new Error('Missing box code. Normal unboxing cannot be saved to unknown.');
  const adate = normalizeArrivalDate(req.body.arrival_date);
  if (!adate) throw new Error('Please choose an existing arrival date. Cannot save to unknown.');
  const remark = isNoPo ? getNoPoRemark(req) : '';
  const filePo = hasPo ? sanitizeCodeSegment(po, 'NOPO') : 'NOPO';
  const suffix = isNoPo ? `（${remark}）` : '';
  return {
    rawPo: filePo, rawBox: 'NOBOXCODE', rawDate: adate,
    relDir: `${adate}/No box code`, absDir: ensureNoBoxUploadDir(adate),
    filename: `${filePo}_NOBOXCODE_${buildPhotoStamp()}${suffix}.jpg`
  };
}
function buildPhotoStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function resolveErrorPhotoMeta(req) {
  const po = normalizePoCode(req.body.po_code);
  assertValidPoCode(po);
  const ext = getPhotoExt(req);
  return {
    rawPo: sanitizeCodeSegment(po, 'NOPO'),
    relDir: 'Error PO Paper',
    absDir: ensureDir(path.join(UPLOADS_DIR, 'Error PO Paper')),
    filename: `${sanitizeCodeSegment(po, 'NOPO')}_error_${buildPhotoStamp()}${ext}`
  };
}

const poUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      req.file = file;
      const meta = resolvePoUploadMeta(req);
      req._photoRelDir = meta.relDir;
      req._photoMeta = meta;
      cb(null, meta.absDir);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    try {
      const meta = req._photoMeta || resolvePoUploadMeta(req);
      cb(null, meta.filename);
    } catch (e) { cb(e); }
  }
});
const poUpload = multer({ storage: poUploadStorage, limits: { fileSize: 30*1024*1024 },
  fileFilter: (req, file, cb) => { file.mimetype.startsWith('image/') ? cb(null,true) : cb(new Error('Images only')); }
});
const errorUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      req.file = file;
      const meta = resolveErrorPhotoMeta(req);
      req._photoRelDir = meta.relDir;
      req._photoMeta = meta;
      cb(null, meta.absDir);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    try {
      const meta = req._photoMeta || resolveErrorPhotoMeta(req);
      cb(null, meta.filename);
    } catch (e) { cb(e); }
  }
});
const errorUpload = multer({ storage: errorUploadStorage, limits: { fileSize: 30*1024*1024 },
  fileFilter: (req, file, cb) => { file.mimetype.startsWith('image/') ? cb(null,true) : cb(new Error('Images only')); }
});
const xlsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });

function getPhotoPath(req) {
  if (!req.file) return null;
  const rel = req._photoRelDir || '';
  return rel ? `${rel}/${req.file.filename}` : req.file.filename;
}

app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(PUBLIC_DIR));
app.get('/api/health', (req,res) => res.json({ status:'ok' }));

// ════════════════════════════════════════
// BOX TABLE + ARRIVAL DATES
// ════════════════════════════════════════
app.get('/api/boxes/table', (req, res) => {
  const arrivals = db.prepare('SELECT * FROM arrivals ORDER BY box_code').all();
  const shippedRows = db.prepare(`SELECT sb.*, b.revoked_at FROM shipment_boxes sb
    JOIN shipment_batches b ON b.id=sb.batch_id
    WHERE b.revoked_at IS NULL
    ORDER BY sb.box_code`).all();

  const shipped = {}; // sdate -> seq -> shipment cell
  const arrivedOnly = {}; // sdate -> seq -> arrival cell with no shipment record
  const allDates = new Set();
  let global_max_seq = 0;

  for (const s of shippedRows) {
    const p = parseBoxCode(s.box_code);
    if (!p) continue;
    allDates.add(p.date);
    if (!shipped[p.date]) shipped[p.date] = {};
    shipped[p.date][p.seq] = {
      type_code: s.type_code,
      shipped: true,
      arrived: false,
      box_code: s.box_code,
      segment_no: s.segment_no || 0,
      segment_seq: s.segment_seq || 0,
      shipment_batch_id: s.batch_id,
      shipment_date: displayShipmentDate(s.shipment_date),
      arrival_date: null,
      arrival_id: null,
      source: 'shipment'
    };
    global_max_seq = Math.max(global_max_seq, p.seq);
  }

  for (const a of arrivals) {
    const p = parseBoxCode(a.box_code);
    if (!p) continue;
    allDates.add(p.date);
    global_max_seq = Math.max(global_max_seq, p.seq);
    if (shipped[p.date]?.[p.seq]) {
      shipped[p.date][p.seq] = {
        ...shipped[p.date][p.seq],
        arrived: true,
        arrival_date: a.arrival_date,
        arrival_id: a.id,
        unboxed_at: a.unboxed_at || null,
        worker_name: a.worker_name || ''
      };
    } else {
      if (!arrivedOnly[p.date]) arrivedOnly[p.date] = {};
      arrivedOnly[p.date][p.seq] = {
        type_code: p.type,
        shipped: false,
        arrived: true,
        box_code: a.box_code,
        shipment_batch_id: null,
        shipment_date: displayShipmentDate(p.date),
        arrival_date: a.arrival_date,
        arrival_id: a.id,
        unboxed_at: a.unboxed_at || null,
        worker_name: a.worker_name || '',
        source: 'arrival_only'
      };
    }
  }

  const shipment_dates = Array.from(allDates).sort().reverse();
  const table = {};
  const date_meta = {};

  for (const sdate of shipment_dates) {
    table[sdate] = {};
    const typeRanges = {};
    const seqTypeMap = {};
    const cells = { ...(shipped[sdate] || {}), ...(arrivedOnly[sdate] || {}) };
    const seqs = Object.keys(cells).map(Number).sort((a,b)=>a-b);
    for (const seq of seqs) {
      const c = cells[seq];
      table[sdate][seq] = c;
      if (!typeRanges[c.type_code]) typeRanges[c.type_code] = { min: seq, max: seq, count: 0 };
      typeRanges[c.type_code].min = Math.min(typeRanges[c.type_code].min, seq);
      typeRanges[c.type_code].max = Math.max(typeRanges[c.type_code].max, seq);
      typeRanges[c.type_code].count += 1;
      seqTypeMap[seq] = c.type_code;
    }
    for (const [tc, range] of Object.entries(typeRanges)) {
      for (let s = range.min; s <= range.max; s++) {
        if (!table[sdate][s]) {
          table[sdate][s] = {
            type_code: tc,
            shipped: false,
            arrived: false,
            box_code: `${sdate}${tc}${String(s).padStart(3,'0')}`,
            shipment_batch_id: null,
            shipment_date: displayShipmentDate(sdate),
            arrival_date: null,
            arrival_id: null,
            source: 'gap'
          };
        }
      }
    }
    const segments = [];
    let currentSegment = null;
    for (const seq of seqs) {
      const c = cells[seq];
      if (!c?.shipped) continue;
      const key = c.segment_no ? `${c.segment_no}:${c.type_code}` : c.type_code;
      if (!currentSegment || currentSegment.key !== key) {
        currentSegment = { key, type_code:c.type_code, start_seq:seq, end_seq:seq, count:1 };
        segments.push(currentSegment);
      } else {
        currentSegment.end_seq = seq;
        currentSegment.count += 1;
      }
    }
    const shipped_count = Object.values(table[sdate]).filter(c=>c.shipped).length;
    const arrived_count = Object.values(table[sdate]).filter(c=>c.arrived).length;
    date_meta[sdate] = {
      display: fmtShipDate(sdate),
      display_short: displayShipmentDate(sdate),
      types: typeRanges,
      segments: segments.map(({key, ...seg}) => seg),
      max_seq: seqs.length ? Math.max(...Object.keys(table[sdate]).map(Number)) : 0,
      shipped_count,
      arrived_count,
      remaining_count: Math.max(shipped_count - Object.values(table[sdate]).filter(c=>c.shipped && c.arrived).length, 0)
    };
  }

  res.json({ shipment_dates, global_max_seq, table, date_meta });
});

app.get('/api/arrivals/dates', (req, res) => {
  const rows = db.prepare(`SELECT COALESCE(arrival_date, date(scanned_at)) as adate, box_code FROM arrivals ORDER BY adate DESC`).all();
  const byDate = {};
  for (const r of rows) {
    const adate = r.adate;
    if (!byDate[adate]) byDate[adate] = {};
    const p = parseBoxCode(r.box_code);
    const sdate = p ? p.date : '__other__';
    byDate[adate][sdate] = (byDate[adate][sdate] || 0) + 1;
  }
  const result = Object.entries(byDate).sort((a,b)=>b[0].localeCompare(a[0])).map(([adate, sdates]) => ({
    arrival_date: adate,
    display: fmtArrDate(adate),
    count: Object.values(sdates).reduce((s,n)=>s+n, 0),
    shipments: Object.entries(sdates).map(([sd, count]) => ({
      shipment_date: sd, display: sd==='__other__'?'格式不符':fmtShipDate(sd), count
    }))
  }));
  res.json(result);
});

app.get('/api/arrivals/boxes', (req, res) => {
  const adate = normalizeArrivalDate(req.query.arrival_date);
  if (!adate) return res.status(400).json({ error: 'Invalid arrival date' });
  const rows = db.prepare(`
    SELECT a.*, COUNT(pr.id) as po_count
    FROM arrivals a
    LEFT JOIN po_records pr ON pr.box_code = a.box_code
    WHERE a.arrival_date = ?
    GROUP BY a.id
    ORDER BY a.box_code
  `).all(adate);
  res.json(rows);
});

// ════════════════════════════════════════
// SHIPMENTS
// ════════════════════════════════════════
app.get('/api/shipments/overview', (req, res) => {
  const rows = db.prepare(`SELECT sb.*, b.id as batch_id, b.created_at as batch_created_at, b.revoked_at,
    a.id as arrival_id, a.arrival_date
    FROM shipment_boxes sb
    JOIN shipment_batches b ON b.id=sb.batch_id
    LEFT JOIN arrivals a ON a.box_code=sb.box_code
    WHERE b.revoked_at IS NULL
    ORDER BY sb.shipment_date DESC, sb.seq_no ASC`).all();
  const byDate = {};
  for (const r of rows) {
    if (!byDate[r.shipment_date]) byDate[r.shipment_date] = { shipment_date:r.shipment_date, display:displayShipmentDate(r.shipment_date), total:0, arrived:0, in_transit:0, type_summary:{}, segments:[], boxes:[] };
    const g = byDate[r.shipment_date];
    g.total++;
    if (r.arrival_id) g.arrived++; else g.in_transit++;
    g.type_summary[r.type_code] = (g.type_summary[r.type_code] || 0) + 1;
    const last = g.segments[g.segments.length - 1];
    const key = r.segment_no ? `${r.segment_no}:${r.type_code}` : r.type_code;
    if (!last || last.key !== key) g.segments.push({ key, type_code:r.type_code, start_seq:r.seq_no, end_seq:r.seq_no, count:1 });
    else { last.end_seq = r.seq_no; last.count += 1; }
    g.boxes.push({ box_code:r.box_code, type_code:r.type_code, seq_no:r.seq_no, segment_no:r.segment_no || 0, segment_seq:r.segment_seq || 0, arrival_date:r.arrival_date || null });
  }
  const result = Object.values(byDate).map(g => ({ ...g, segments:g.segments.map(({key, ...seg}) => seg) }));
  res.json(result.sort((a,b)=>b.shipment_date.localeCompare(a.shipment_date)));
});
app.post('/api/shipments/batch', (req, res) => {
  try {
    const { shipment_date, total_count, items, operator } = req.body;
    const built = buildShipmentCodes(shipment_date, items);
    if (parseInt(total_count,10) !== built.total_count) return res.status(400).json({ error:'总箱数与代号箱数合计不一致' });
    let batchId;
    db.transaction(() => {
      const exists = db.prepare(`SELECT sb.box_code FROM shipment_boxes sb JOIN shipment_batches b ON b.id=sb.batch_id WHERE b.revoked_at IS NULL AND sb.box_code IN (${built.boxes.map(()=>'?').join(',')}) LIMIT 1`).get(...built.boxes.map(b=>b.box_code));
      if (exists) {
        const err = new Error(`箱号已存在于未撤回发货记录：${exists.box_code}`);
        err.statusCode = 409;
        throw err;
      }
      const r = db.prepare('INSERT INTO shipment_batches (shipment_date,total_count,payload_json,operator) VALUES(?,?,?,?)').run(built.shipment_date, built.total_count, JSON.stringify(items), operator || '管理员');
      batchId = r.lastInsertRowid;
      const stmt = db.prepare('INSERT INTO shipment_boxes (batch_id,shipment_date,type_code,seq_no,box_code,segment_no,segment_seq) VALUES(?,?,?,?,?,?,?)');
      for (const box of built.boxes) stmt.run(batchId, box.shipment_date, box.type_code, box.seq_no, box.box_code, box.segment_no, box.segment_seq);
    })();
    res.json({ success:true, batch_id:batchId, shipment_date:built.shipment_date, total_count:built.total_count, boxes:built.boxes });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error:e.message });
    if (isSqliteConstraintError(e)) return res.status(409).json({ error:'发货记录保存失败：数据约束冲突，请检查是否存在重复未撤回箱号。', detail:e.message });
    res.status(400).json({ error:e.message });
  }
});
app.get('/api/shipments/batches', (req, res) => {
  const rows = db.prepare(`SELECT b.*,
    (SELECT COUNT(*) FROM shipment_boxes sb WHERE sb.batch_id=b.id) as generated_count,
    CASE WHEN b.revoked_at IS NULL THEN
      (SELECT COUNT(*) FROM shipment_boxes sb JOIN arrivals a ON a.box_code=sb.box_code WHERE sb.batch_id=b.id)
    ELSE 0 END as arrived_count
    FROM shipment_batches b ORDER BY b.created_at DESC LIMIT 50`).all();
  res.json(rows.map(r=>({ ...r, remaining_count: r.revoked_at ? 0 : Math.max((r.generated_count||0)-(r.arrived_count||0),0) })));
});
app.delete('/api/shipments/batches/:id', (req, res) => {
  const batch = db.prepare('SELECT * FROM shipment_batches WHERE id=?').get(req.params.id);
  if (!batch) return res.status(404).json({ error:'未找到提交记录' });
  if (batch.revoked_at) return res.status(400).json({ error:'该记录已撤回' });
  db.prepare(`UPDATE shipment_batches SET revoked_at=strftime('%Y-%m-%d %H:%M:%S','now','localtime'), revoked_by=? WHERE id=?`).run('管理员', req.params.id);
  res.json({ success:true });
});
app.post('/api/shipments/fill-remaining', (req, res) => {
  const { shipment_date, arrival_date, worker_name } = req.body;
  const sdate = normalizeShipmentDate(shipment_date);
  if (!sdate || !arrival_date) return res.status(400).json({ error:'参数不完整' });
  const rows = db.prepare(`SELECT sb.box_code FROM shipment_boxes sb
    JOIN shipment_batches b ON b.id=sb.batch_id
    LEFT JOIN arrivals a ON a.box_code=sb.box_code
    WHERE b.revoked_at IS NULL AND sb.shipment_date=? AND a.id IS NULL
    ORDER BY sb.seq_no`).all(sdate);
  let created = 0;
  const adate = normalizeArrivalDate(arrival_date);
  db.transaction(() => {
    const stmt = db.prepare('INSERT INTO arrivals (box_code,arrival_date,worker_name) VALUES(?,?,?)');
    for (const r of rows) { stmt.run(r.box_code, adate, worker_name || '整批补到货'); ensureArrivalUploadDir(r.box_code, adate); created++; }
  })();
  res.json({ success:true, created, shipment_date:sdate, arrival_date });
});

// ════════════════════════════════════════
// ARRIVALS
// ════════════════════════════════════════
app.post('/api/arrival', (req, res) => {
  try {
    const { box_code, worker_name, notes, arrival_date } = req.body;
    const code = String(box_code || '').trim().toUpperCase();
    assertValidBoxCode(code);
    const ex = db.prepare('SELECT id,scanned_at FROM arrivals WHERE box_code=?').get(code);
    if (ex) return res.status(409).json({ error: 'This box code has already been recorded', scanned_at: ex.scanned_at });
    const adate = normalizeArrivalDate(arrival_date) || new Date().toLocaleDateString('sv-SE');
    const r = db.prepare('INSERT INTO arrivals (box_code,worker_name,notes,arrival_date) VALUES(?,?,?,?)')
      .run(code, worker_name||'未知', notes||null, adate);
    ensureArrivalUploadDir(code, adate);
    res.json({ success:true, id:r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error:e.message }); }
});
app.get('/api/arrival/recent', (req,res) =>
  res.json(db.prepare('SELECT * FROM arrivals ORDER BY scanned_at DESC LIMIT ?').all(parseInt(req.query.limit)||10)));
app.put('/api/arrival/:id', (req, res) => {
  const { arrival_date, notes, worker_name } = req.body;
  const row = db.prepare('SELECT box_code FROM arrivals WHERE id=?').get(req.params.id);
  const adate = normalizeArrivalDate(arrival_date) || null;
  db.prepare('UPDATE arrivals SET arrival_date=?, notes=?, worker_name=COALESCE(?,worker_name) WHERE id=?')
    .run(adate, notes||null, worker_name||null, req.params.id);
  if (row?.box_code && adate) ensureArrivalUploadDir(row.box_code, adate);
  res.json({ success:true });
});
app.delete('/api/arrival/:id', (req, res) => {
  db.prepare('DELETE FROM arrivals WHERE id=?').run(req.params.id);
  res.json({ success:true });
});
// Upsert by box_code (single cell edit from table)
app.post('/api/arrival/upsert', (req, res) => {
  const { box_code, arrival_date, worker_name } = req.body;
  const adate = normalizeArrivalDate(arrival_date);
  if (!box_code || !adate) return res.status(400).json({ error: 'Missing required parameters' });
  const ex = db.prepare('SELECT id FROM arrivals WHERE box_code=?').get(box_code);
  if (ex) {
    db.prepare('UPDATE arrivals SET arrival_date=? WHERE id=?').run(adate, ex.id);
    ensureArrivalUploadDir(box_code, adate);
    res.json({ success:true, action:'updated', id:ex.id });
  } else {
    const r = db.prepare('INSERT INTO arrivals (box_code,arrival_date,worker_name) VALUES(?,?,?)')
      .run(box_code, adate, worker_name||'手动录入');
    ensureArrivalUploadDir(box_code, adate);
    res.json({ success:true, action:'created', id:r.lastInsertRowid });
  }
});
// Bulk upsert (batch mode)
app.put('/api/arrivals/bulk', (req, res) => {
  const { box_codes, arrival_date, worker_name } = req.body;
  if (!box_codes || !Array.isArray(box_codes) || !arrival_date)
    return res.status(400).json({ error: 'Missing required parameters' });
  let updated=0, created=0;
  const adate = normalizeArrivalDate(arrival_date);
  db.transaction(() => {
    for (const code of box_codes) {
      const ex = db.prepare('SELECT id FROM arrivals WHERE box_code=?').get(code);
      if (ex) { db.prepare('UPDATE arrivals SET arrival_date=? WHERE id=?').run(adate, ex.id); updated++; }
      else { db.prepare('INSERT INTO arrivals (box_code,arrival_date,worker_name) VALUES(?,?,?)').run(code, adate, worker_name||'批量修改'); created++; }
      ensureArrivalUploadDir(code, adate);
    }
  })();
  res.json({ success:true, updated, created });
});

// ════════════════════════════════════════
// UNBOXING
// ════════════════════════════════════════
app.post('/api/unboxing/session', (req, res) => {
  try {
    const { box_code, worker_name, arrival_date } = req.body;
    const code = String(box_code || '').trim().toUpperCase();
    ensureArrivalForUpload(code, arrival_date, worker_name);
    const r = db.prepare('INSERT INTO unboxing_sessions (box_code,worker_name) VALUES(?,?)').run(code, worker_name||'未知');
    db.prepare(`UPDATE arrivals SET unboxed_at=strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE box_code=? AND unboxed_at IS NULL`).run(code);
    res.json({ success:true, session_id:r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/unboxing/po', (req, res) => {
  poUpload.single('photo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const { session_id, box_code, selected_box_code, po_code, notes, no_po_reason } = req.body;
      const code = String(box_code || selected_box_code || '').trim().toUpperCase();
      assertValidBoxCode(code);
      const finalPo = po_code ? normalizePoCode(po_code) : 'NOPO';
      if (po_code) assertValidPoCode(finalPo);
      if (!po_code && !(no_po_reason || notes)) return res.status(400).json({ error: 'Missing PO code. If there is no PO paper, select a reason.' });
      const photo_path = getPhotoPath(req);
      const arrivalDate = req._photoMeta?.rawDate || null;
      const r = db.prepare('INSERT INTO po_records (session_id,box_code,arrival_date,po_code,photo_path,notes) VALUES(?,?,?,?,?,?)')
        .run(session_id||null, code, arrivalDate, finalPo, photo_path, notes||no_po_reason||null);
      res.json({ success:true, id:r.lastInsertRowid });
    } catch(e) { res.status(400).json({ error:e.message }); }
  });
});
app.post('/api/po-record/manual', (req, res) => {
  pcUpload.single('photo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const { po_code, notes, box_code } = req.body;
      const finalPo = normalizePoCode(po_code);
      assertValidPoCode(finalPo);
      const finalBox = String(box_code || '').trim().toUpperCase();
      const arrivalDate = req._photoMeta?.rawDate || null;
      const photo_path = getPhotoPath(req);
      const r = db.prepare('INSERT INTO po_records (box_code,arrival_date,po_code,photo_path,notes) VALUES(?,?,?,?,?)')
        .run(finalBox, arrivalDate, finalPo, photo_path, notes||null);
      res.json({ success:true, id:r.lastInsertRowid, arrival_date:arrivalDate, photo_path });
    } catch(e) { res.status(400).json({ error:e.message }); }
  });
});

// PC operator upload: keeps date-based fallback when box_code is unknown
const pcUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      req.file = file;
      const meta = resolvePoUploadMeta(req, { allowArrivalDateFallback:true });
      req._photoRelDir = meta.relDir;
      req._photoMeta = meta;
      cb(null, meta.absDir);
    } catch (e) { cb(e); }
  },
  filename: (req, file, cb) => {
    try {
      const meta = req._photoMeta || resolvePoUploadMeta(req, { allowArrivalDateFallback:true });
      cb(null, meta.filename);
    } catch (e) { cb(e); }
  }
});
const pcUpload = multer({ storage: pcUploadStorage, limits: { fileSize: 30*1024*1024 },
  fileFilter: (req, file, cb) => { file.mimetype.startsWith('image/') ? cb(null,true) : cb(new Error('Images only')); }
});

app.post('/api/po-record/pc', (req, res) => {
  pcUpload.single('photo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const { po_code, notes, no_po_reason } = req.body;
      const finalPo = po_code ? normalizePoCode(po_code) : 'NOPO';
      if (po_code) assertValidPoCode(finalPo);
      if (!po_code && !(no_po_reason || notes)) return res.status(400).json({ error: 'Missing PO code. If there is no PO paper, select a reason.' });
      const photo_path = req.file ? `${req._photoRelDir}/${req.file.filename}` : null;
      const arrivalDate = req._photoMeta?.rawDate || null;
      const r = db.prepare("INSERT INTO po_records (box_code,arrival_date,po_code,photo_path,notes) VALUES('',?,?,?,?)")
        .run(arrivalDate, finalPo, photo_path, notes||no_po_reason||null);
      res.json({ success:true, id:r.lastInsertRowid });
    } catch(e) { res.status(400).json({ error:e.message }); }
  });
});
app.put('/api/po-record/:id', (req, res) => {
  const { notes, po_code } = req.body;
  db.prepare('UPDATE po_records SET notes=?, po_code=COALESCE(?,po_code) WHERE id=?').run(notes||null, po_code||null, req.params.id);
  res.json({ success:true });
});
app.delete('/api/po-record/:id', (req, res) => {
  const rec = db.prepare('SELECT photo_path FROM po_records WHERE id=?').get(req.params.id);
  db.prepare('UPDATE error_records SET linked_po_record_id=NULL WHERE linked_po_record_id=?').run(req.params.id);
  db.prepare('DELETE FROM po_records WHERE id=?').run(req.params.id);
  if (rec?.photo_path) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, rec.photo_path)); } catch {}
  }
  res.json({ success:true });
});
app.get('/api/po/all', (req, res) => {
  const { sort='created_at', dir='DESC', search='' } = req.query;
  const validSort = { po_code:'pr.po_code', created_at:'pr.created_at' };
  const col = validSort[sort]||'pr.created_at', d = dir==='ASC'?'ASC':'DESC';
  let sql = `SELECT pr.*, a.arrival_date as box_arrival_date, a.unboxed_at,
    (SELECT COUNT(*) FROM error_records e WHERE e.linked_po_record_id=pr.id) as error_count
    FROM po_records pr LEFT JOIN arrivals a ON pr.box_code=a.box_code`;
  const p = [];
  if (search) { sql += ' WHERE pr.po_code LIKE ?'; p.push(`%${search}%`); }
  sql += ` ORDER BY ${col} ${d}`;
  const rows = db.prepare(sql).all(...p).map(r => ({ ...r, arrival_date: resolvePoArrivalDate(r) }));
  res.json(rows);
});
app.get('/api/po/overview', (req, res) => {
  const search = String(req.query.search || '').trim();
  let sql = `SELECT pr.id, pr.po_code, pr.box_code, pr.arrival_date, pr.photo_path, pr.notes, pr.created_at,
    a.arrival_date as box_arrival_date,
    (SELECT COUNT(*) FROM error_records e WHERE e.linked_po_record_id=pr.id) as error_count
    FROM po_records pr
    LEFT JOIN arrivals a ON a.box_code=pr.box_code`;
  const params = [];
  if (search) { sql += ' WHERE pr.po_code LIKE ?'; params.push(`%${search}%`); }
  sql += ' ORDER BY pr.po_code ASC, pr.created_at ASC';
  const rows = db.prepare(sql).all(...params);
  const byDate = {};
  for (const row of rows) {
    const resolvedArrivalDate = resolvePoArrivalDate(row);
    const r = { ...row, arrival_date: resolvedArrivalDate, group_arrival_date: resolvedArrivalDate };
    const adate = r.group_arrival_date || '未关联到货';
    if (!byDate[adate]) byDate[adate] = { arrival_date: adate, po_map: {} };
    if (!byDate[adate].po_map[r.po_code]) byDate[adate].po_map[r.po_code] = { po_code: r.po_code, error_count: 0, has_error: false, records: [] };
    const p = byDate[adate].po_map[r.po_code];
    p.records.push(r);
    p.error_count += Number(r.error_count || 0);
    if (Number(r.error_count || 0) > 0) p.has_error = true;
  }
  const result = Object.values(byDate).map(g => ({
    arrival_date: g.arrival_date,
    pos: Object.values(g.po_map).sort((a,b)=>a.po_code.localeCompare(b.po_code))
  })).sort((a,b)=>String(b.arrival_date).localeCompare(String(a.arrival_date)));
  res.json(result);
});

// ════════════════════════════════════════
// ERRORS
// ════════════════════════════════════════
app.post('/api/error', (req, res) => {
  errorUpload.single('photo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const { po_code, error_description, worker_name } = req.body;
      const finalPo = normalizePoCode(po_code);
      assertValidPoCode(finalPo);
      const photo_path = getPhotoPath(req);
      const r = db.prepare('INSERT INTO error_records (po_code,photo_path,error_description,worker_name) VALUES(?,?,?,?)')
        .run(finalPo, photo_path, error_description||null, worker_name||'未知');
      res.json({ success:true, id:r.lastInsertRowid });
    } catch(e) { res.status(400).json({ error:e.message }); }
  });
});
app.get('/api/errors', (req, res) => {
  const { status, date_from, date_to, po_code } = req.query;
  let sql = `SELECT er.*, pr.box_code as linked_box FROM error_records er LEFT JOIN po_records pr ON er.linked_po_record_id=pr.id WHERE 1=1`;
  const p = [];
  if (status)    { sql += ' AND er.review_status=?';     p.push(status); }
  if (date_from) { sql += ' AND date(er.created_at)>=?'; p.push(date_from); }
  if (date_to)   { sql += ' AND date(er.created_at)<=?'; p.push(date_to); }
  if (po_code)   { sql += ' AND er.po_code LIKE ?';      p.push(`%${po_code}%`); }
  sql += ' ORDER BY er.created_at DESC';
  res.json(db.prepare(sql).all(...p));
});
app.post('/api/errors/:id/create-po-record', (req, res) => {
  let copiedPath = null;
  try {
    const errorRecord = db.prepare('SELECT * FROM error_records WHERE id=?').get(req.params.id);
    if (!errorRecord) return res.status(404).json({ error: '未找到错误订单' });
    if (!errorRecord.photo_path) return res.status(400).json({ error: '错误订单没有图片，无法录入采购单' });

    const sourcePath = resolveUploadPath(errorRecord.photo_path);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      return res.status(400).json({ error: '错误订单图片源文件不存在，未创建采购单记录' });
    }

    const finalPo = normalizePoCode(req.body.po_code || errorRecord.po_code);
    assertValidPoCode(finalPo);
    const arrivalDate = assertExistingArrivalDate(req.body.arrival_date);
    const notes = req.body.notes || `由错误订单 #${errorRecord.id} 一键录入`;
    const target = buildNoBoxPoPhotoPath(finalPo, arrivalDate);

    fs.copyFileSync(sourcePath, target.absPath);
    copiedPath = target.absPath;

    let poRecordId;
    db.transaction(() => {
      const r = db.prepare("INSERT INTO po_records (box_code,arrival_date,po_code,photo_path,notes) VALUES('',?,?,?,?)")
        .run(arrivalDate, finalPo, target.relPath, notes || null);
      poRecordId = r.lastInsertRowid;
      const u = db.prepare('UPDATE error_records SET linked_po_record_id=? WHERE id=?').run(poRecordId, errorRecord.id);
      if (u.changes !== 1) throw new Error('关联错误订单失败');
    })();

    res.json({ success:true, id:poRecordId, po_record_id:poRecordId, linked_error_id:errorRecord.id, arrival_date:arrivalDate, photo_path:target.relPath });
  } catch(e) {
    if (copiedPath) { try { fs.unlinkSync(copiedPath); } catch {} }
    if (isSqliteConstraintError(e)) return res.status(409).json({ error:'创建采购单失败：数据约束冲突', detail:e.message });
    res.status(400).json({ error:e.message });
  }
});
app.get('/api/errors/:id', (req, res) => {
  const record = db.prepare(`SELECT er.*, pr.box_code as linked_box, pr.po_code as linked_po_code,
    pr.created_at as linked_unboxing_date, pr.photo_path as linked_photo_path, pr.id as linked_po_id
    FROM error_records er LEFT JOIN po_records pr ON er.linked_po_record_id=pr.id WHERE er.id=?`).get(req.params.id);
  if (!record) return res.status(404).json({ error: '未找到' });
  const po_records = db.prepare(`SELECT pr.*, a.arrival_date as box_arrival_date, a.unboxed_at,
    (SELECT COUNT(*) FROM error_records e2 WHERE e2.linked_po_record_id=pr.id) as error_count
    FROM po_records pr LEFT JOIN arrivals a ON pr.box_code=a.box_code WHERE pr.po_code=? ORDER BY pr.created_at DESC`)
    .all(record.po_code)
    .map(r => ({ ...r, arrival_date: resolvePoArrivalDate(r) }));
  const related_errors = db.prepare('SELECT * FROM error_records WHERE po_code=? AND id!=? ORDER BY created_at DESC').all(record.po_code, record.id);
  const arrival = record.linked_box ? db.prepare('SELECT * FROM arrivals WHERE box_code=? LIMIT 1').get(record.linked_box) : null;
  res.json({ record, po_records, related_errors, arrival });
});
app.put('/api/errors/:id/review', (req, res) => {
  const { review_status, review_notes, reviewed_by } = req.body;
  db.prepare(`UPDATE error_records SET review_status=?,review_notes=?,reviewed_by=?,
    reviewed_at=strftime('%Y-%m-%d %H:%M:%S','now','localtime') WHERE id=?`).run(review_status, review_notes||null, reviewed_by||'管理员', req.params.id);
  res.json({ success:true });
});
app.put('/api/errors/:id/edit', (req, res) => {
  db.prepare('UPDATE error_records SET po_code=COALESCE(?,po_code), error_description=? WHERE id=?')
    .run(req.body.po_code||null, req.body.error_description||null, req.params.id);
  res.json({ success:true });
});
app.put('/api/errors/:id/link-po', (req, res) => {
  db.prepare('UPDATE error_records SET linked_po_record_id=? WHERE id=?').run(req.body.po_record_id||null, req.params.id);
  res.json({ success:true });
});
app.delete('/api/errors/:id', (req, res) => {
  const rec = db.prepare('SELECT photo_path FROM error_records WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM error_records WHERE id=?').run(req.params.id);
  if (rec?.photo_path) {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, rec.photo_path)); } catch {}
  }
  res.json({ success:true });
});

// ════════════════════════════════════════
// BOX / PO FINDER
// ════════════════════════════════════════
app.get('/api/box/:code', (req, res) => {
  const code = req.params.code;
  const arrival = db.prepare('SELECT * FROM arrivals WHERE box_code=? LIMIT 1').get(code);
  const po_records = db.prepare(`SELECT pr.*,(SELECT COUNT(*) FROM error_records e WHERE e.linked_po_record_id=pr.id) as error_count FROM po_records pr WHERE pr.box_code=? ORDER BY pr.created_at`).all(code)
    .map(r => ({ ...r, arrival_date: resolvePoArrivalDate(r) }));
  const errors = db.prepare('SELECT * FROM error_records WHERE box_code=? ORDER BY created_at').all(code);
  res.json({ box_code:code, arrival, po_records, error_records:errors });
});

// ════════════════════════════════════════
// EXCEL IMPORT
// ════════════════════════════════════════
const COL_MAP = {
  box_code:     ['箱码','box_code','箱子码','box code','boxcode','箱子二维码'],
  arrival_date: ['到货日期','arrival_date','date','日期'],
  worker_name:  ['操作人','worker_name','操作员','worker','人员'],
  notes:        ['备注','notes','note','remark'],
};
function findCol(headers, aliases) {
  const lc = headers.map(h=>String(h||'').trim().toLowerCase());
  for (const a of aliases) { const idx=lc.indexOf(a.toLowerCase()); if(idx!==-1) return idx; }
  return -1;
}
function parseImportFile(buffer) {
  const wb = XLSX.read(buffer, { type:'buffer', cellDates:false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
  if (rows.length < 2) throw new Error('文件为空或缺少数据行');
  const headers = rows[0].map(h=>String(h||'').trim());
  const ci = { box_code:findCol(headers,COL_MAP.box_code), arrival_date:findCol(headers,COL_MAP.arrival_date), worker_name:findCol(headers,COL_MAP.worker_name), notes:findCol(headers,COL_MAP.notes) };
  if (ci.box_code===-1) throw new Error('找不到"箱码"列，请检查表头');
  const today = new Date().toLocaleDateString('sv-SE');
  const result = [];
  for (let i=1;i<rows.length;i++) {
    const row = rows[i];
    const rawCode = String(row[ci.box_code]||'').trim();
    if (!rawCode) continue;
    let dateVal = today;
    if (ci.arrival_date!==-1 && row[ci.arrival_date]!=='') {
      const raw = row[ci.arrival_date];
      if (typeof raw==='number' && raw>1) {
        const pd = XLSX.SSF.parse_date_code(raw);
        dateVal = `${pd.y}-${String(pd.m).padStart(2,'0')}-${String(pd.d).padStart(2,'0')}`;
      } else {
        const s = String(raw).trim().replace(/[\/\.]/g,'-');
        if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
          const pts = s.split('-');
          dateVal = `${pts[0]}-${pts[1].padStart(2,'0')}-${pts[2].padStart(2,'0')}`;
        } else if (/^\d{8}$/.test(s)) dateVal=`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
      }
    }
    result.push({ row:i+1, box_code:rawCode, arrival_date:dateVal, worker_name:ci.worker_name!==-1?String(row[ci.worker_name]||'').trim()||'批量导入':'批量导入', notes:ci.notes!==-1?String(row[ci.notes]||'').trim()||null:null });
  }
  return result;
}
app.post('/api/import/preview', xlsUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  try {
    const rows = parseImportFile(req.file.buffer);
    const annotated = rows.map(r => { const ex=db.prepare('SELECT scanned_at,arrival_date FROM arrivals WHERE box_code=?').get(r.box_code); return {...r,exists:!!ex,existing_date:ex?(ex.arrival_date||ex.scanned_at?.slice(0,10)):null}; });
    res.json({ success:true, total:annotated.length, rows:annotated });
  } catch(e) { res.status(400).json({ error:e.message }); }
});
app.post('/api/import/confirm', (req, res) => {
  const { rows, skip_duplicates, operator } = req.body;
  if (!rows||!Array.isArray(rows)) return res.status(400).json({ error:'无效数据' });
  const insert = db.prepare('INSERT INTO arrivals (box_code,worker_name,notes,arrival_date) VALUES(?,?,?,?)');
  let imported=0, skipped=0, errors=[], successCodes=[];
  db.transaction(()=>{
    for (const r of rows) {
      if (!r.box_code) continue;
      const adate = normalizeArrivalDate(r.arrival_date) || r.arrival_date;
      const ex = db.prepare('SELECT id FROM arrivals WHERE box_code=?').get(r.box_code);
      if (ex) { if(skip_duplicates){skipped++;continue;} db.prepare('UPDATE arrivals SET arrival_date=?,notes=?,worker_name=? WHERE box_code=?').run(adate,r.notes||null,r.worker_name||'批量导入',r.box_code); ensureArrivalUploadDir(r.box_code, adate); successCodes.push(r.box_code); imported++; }
      else { try{insert.run(r.box_code,r.worker_name||'批量导入',r.notes||null,adate); ensureArrivalUploadDir(r.box_code, adate); successCodes.push(r.box_code); imported++;}catch(e){errors.push({box_code:r.box_code,error:e.message});} }
    }
  })();
  if (successCodes.length>0) db.prepare('INSERT INTO import_logs (imported_codes,count,skip_dup,operator) VALUES(?,?,?,?)').run(JSON.stringify(successCodes),successCodes.length,skip_duplicates?1:0,operator||'管理员');
  res.json({ success:true, imported, skipped, errors });
});
app.get('/api/import/logs', (req,res) => res.json(db.prepare('SELECT * FROM import_logs ORDER BY created_at DESC LIMIT 30').all()));
app.delete('/api/import/logs/:id', (req, res) => {
  const log = db.prepare('SELECT * FROM import_logs WHERE id=?').get(req.params.id);
  if (!log) return res.status(404).json({ error:'未找到' });
  let codes; try { codes=JSON.parse(log.imported_codes); } catch { return res.status(400).json({ error:'格式错误' }); }
  let deleted=0;
  db.transaction(()=>{ for(const c of codes){db.prepare('DELETE FROM arrivals WHERE box_code=?').run(c);deleted++;} db.prepare('DELETE FROM import_logs WHERE id=?').run(req.params.id); })();
  res.json({ success:true, deleted });
});
app.get('/api/import/template', (req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([['箱码','到货日期','操作人','备注'],['20260315DSH001','2026-03-15','张三',''],['20260315LCC011','2026-03-15','李四','外包装破损']]);
  ws['!cols']=[{wch:20},{wch:14},{wch:10},{wch:20}];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'到货记录');
  const buf = XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Disposition','attachment; filename="template.xlsx"');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ════════════════════════════════════════
// DATABASE EXPORT / IMPORT
// ════════════════════════════════════════
app.get('/api/db/export', (req, res) => {
  const wb = XLSX.utils.book_new();

  // Sheet 1: 到货记录
  const arrivals = db.prepare('SELECT id,box_code,arrival_date,worker_name,notes,unboxed_at,scanned_at FROM arrivals ORDER BY arrival_date DESC,box_code').all();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(arrivals), '到货记录');

  // Sheet 2: 采购单记录
  const pos = db.prepare('SELECT id,box_code,po_code,notes,created_at FROM po_records ORDER BY created_at DESC').all();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pos), '采购单记录');

  // Sheet 3: 错误记录
  const errs = db.prepare('SELECT id,po_code,error_description,review_status,review_notes,reviewed_by,created_at FROM error_records ORDER BY created_at DESC').all();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(errs), '错误记录');

  const buf = XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  const ts = new Date().toLocaleDateString('sv-SE');
  res.setHeader('Content-Disposition',`attachment; filename="warehouse_db_${ts}.xlsx"`);
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.post('/api/db/import', xlsUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error:'未收到文件' });
  try {
    const wb = XLSX.read(req.file.buffer,{type:'buffer',cellDates:false});
    const results = {};

    // Sheet 1: 到货记录 - upsert by box_code
    const arrSheet = wb.Sheets['到货记录'];
    if (arrSheet) {
      const rows = XLSX.utils.sheet_to_json(arrSheet,{defval:''});
      let upd=0,ins=0;
      db.transaction(()=>{
        for (const r of rows) {
          if (!r.box_code) continue;
          const dateVal = r.arrival_date?String(r.arrival_date).trim():null;
          const ex = db.prepare('SELECT id FROM arrivals WHERE box_code=?').get(String(r.box_code));
          if (ex) { db.prepare('UPDATE arrivals SET arrival_date=?,notes=?,worker_name=? WHERE id=?').run(dateVal,r.notes||null,r.worker_name||null,ex.id); if (dateVal) ensureArrivalUploadDir(String(r.box_code), dateVal); upd++; }
          else { try{db.prepare('INSERT INTO arrivals (box_code,arrival_date,worker_name,notes) VALUES(?,?,?,?)').run(String(r.box_code),dateVal,r.worker_name||'DB导入',r.notes||null); if (dateVal) ensureArrivalUploadDir(String(r.box_code), dateVal); ins++;}catch{} }
        }
      })();
      results['到货记录'] = {updated:upd, inserted:ins};
    }

    // Sheet 2: 采购单记录 - update by id
    const poSheet = wb.Sheets['采购单记录'];
    if (poSheet) {
      const rows = XLSX.utils.sheet_to_json(poSheet,{defval:''});
      let upd=0;
      db.transaction(()=>{
        for (const r of rows) {
          if (!r.id) continue;
          db.prepare('UPDATE po_records SET po_code=COALESCE(?,po_code), notes=? WHERE id=?').run(r.po_code||null,r.notes||null,r.id);
          upd++;
        }
      })();
      results['采购单记录'] = {updated:upd};
    }

    // Sheet 3: 错误记录 - update by id
    const errSheet = wb.Sheets['错误记录'];
    if (errSheet) {
      const rows = XLSX.utils.sheet_to_json(errSheet,{defval:''});
      let upd=0;
      db.transaction(()=>{
        for (const r of rows) {
          if (!r.id) continue;
          db.prepare('UPDATE error_records SET error_description=?,review_status=?,review_notes=? WHERE id=?')
            .run(r.error_description||null,r.review_status||'pending',r.review_notes||null,r.id);
          upd++;
        }
      })();
      results['错误记录'] = {updated:upd};
    }

    res.json({ success:true, results });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`[仓库系统] 端口 ${PORT}`));
