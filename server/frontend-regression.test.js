const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'employee.html'), 'utf8');
const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

test('PC upload uses arrival-date dropdown from /api/arrivals/dates, not free date input', () => {
  assert.match(html, /<select[^>]+id="pc-up-date"/);
  assert.doesNotMatch(html, /<input[^>]+type="date"[^>]+id="pc-up-date"/);
  assert.match(html, /fetch\('\/api\/arrivals\/dates'\)/);
});

test('employee frontend validates box code and PO code before upload in English', () => {
  assert.match(html, /function validateBoxInput/);
  assert.match(html, /You scanned a PO code, not a box code/);
  assert.match(html, /function validatePoInput/);
  assert.match(html, /\^POMCMP\\d\{6\}\$/);
  assert.doesNotMatch(html, /你扫到的是采购单号|采购单号格式不正确|箱码格式不正确|请先扫描/);
});

test('unboxing supports explicit NOPO reason instead of silent empty PO upload', () => {
  assert.match(html, /NO_PO_REASONS/);
  assert.match(html, /updateRowNoPoReason/);
  assert.match(html, /fd\.append\('no_po_reason'/);
  assert.match(html, /Photo will be saved as a NOPO evidence file/);
});

test('employee frontend has explicit flows for no box code and selected arrived box', () => {
  assert.match(html, /Box code cannot be scanned/);
  assert.match(html, /Use selected arrived box/);
  assert.match(html, /selected_box_code/);
  assert.match(html, /NOPO_NOBOXCODE/);
});

test('admin manual PO requires existing arrival-date selection and supports image drag-drop', () => {
  assert.match(adminHtml, /<select[^>]+id="mpo-arrival-date"/);
  assert.match(adminHtml, /api\('\/api\/arrivals\/dates'\)/);
  assert.match(adminHtml, /未填写箱码时必须选择到货日期/);
  assert.match(adminHtml, /ondrop="onMpoDrop\(event\)"/);
  assert.match(adminHtml, /只能上传图片文件/);
});
