import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createEventInspector } from '../app.mjs';

const documentHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const records = [
  { id: 'first', channel: 'Application', provider: 'Windows Error Reporting', level: 'Error', eventId: 1001, occurredAt: '2026-09-29T16:00:00Z', message: '<script>alert(1)</script> failed', cabinet: 'CAB-01' },
  { id: 'second', channel: 'System', provider: 'Service Control Manager', level: 'Warning', eventId: 7036, occurredAt: '2026-09-29T16:02:00Z', message: 'A service changed state', cabinet: 'CAB-01' }
];
function setup(data = records) {
  const dom = new JSDOM(documentHtml, { url: 'http://127.0.0.1/' });
  const inspector = createEventInspector(dom.window.document, data);
  return { dom, inspector, doc: dom.window.document };
}

test('selection reveals the collected message and metadata without executing event text', () => {
  const { doc } = setup();
  const row = doc.querySelector('[data-event-id="first"]');
  assert.ok(row);
  row.click();
  assert.equal(doc.querySelector('#selected-provider').textContent, 'Windows Error Reporting');
  assert.equal(doc.querySelector('#selected-message').textContent, '<script>alert(1)</script> failed');
  assert.equal(doc.querySelector('#selected-message script'), null);
  assert.equal(doc.querySelector('[data-event-id="first"]').getAttribute('aria-selected'), 'true');
});

test('search filters events and clears selection when it is no longer visible', () => {
  const { doc, dom } = setup();
  doc.querySelector('[data-event-id="first"]').click();
  const search = doc.querySelector('#event-search');
  search.value = '7036';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(doc.querySelectorAll('[data-event-id]').length, 1);
  assert.equal(doc.querySelector('#selected-event').hidden, true);
  assert.equal(doc.querySelector('#empty-selection').hidden, false);
});

test('cabinet change removes all old event details and rows', () => {
  const { doc, inspector } = setup();
  doc.querySelector('[data-event-id="first"]').click();
  inspector.setCabinet('CAB-02', []);
  assert.equal(doc.querySelector('#selected-event').hidden, true);
  assert.equal(doc.querySelectorAll('[data-event-id]').length, 0);
  assert.match(doc.querySelector('#result-status').textContent, /No events/);
});

test('unavailable data is not replaced with invented fleet or event records', () => {
  const { doc } = setup([]);
  assert.equal(doc.querySelectorAll('[data-event-id]').length, 0);
  assert.match(doc.querySelector('#result-status').textContent, /No events/);
});

test('HTTP preview server is loopback-only and rejects non-loopback binding', async () => {
  const { createPreviewServer } = await import('../server.mjs');
  assert.throws(() => createPreviewServer('0.0.0.0'), /loopback/);
});
