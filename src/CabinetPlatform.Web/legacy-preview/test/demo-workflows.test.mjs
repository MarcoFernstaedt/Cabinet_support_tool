import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { clients, sites, modules, scannerTypes } from '../demo-data.mjs';

async function page() {
  const html = await readFile(new URL('../demo.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../demo-app.mjs', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4174/', runScripts: 'dangerously' });
  dom.window.eval(`const clients = ${JSON.stringify(clients)}; const sites = ${JSON.stringify(sites)}; const modules = ${JSON.stringify(modules)}; const scannerTypes = ${JSON.stringify(scannerTypes)};\n` + script.replace(/^import .*;\s*/, ''));
  const d = dom.window.document;
  return { dom, d, route(hash) { dom.window.location.hash = hash; dom.window.dispatchEvent(new dom.window.Event('hashchange')); } };
}

test('synthetic client and site identities are unique; Sync and Satellite have explicit cabinet types', () => {
  assert.ok(Array.isArray(clients) && clients.length > 1);
  assert.equal(new Set(clients.map(c => c.id)).size, clients.length);
  assert.ok(sites.every(s => clients.some(c => c.id === s.clientId)));
  assert.equal(new Set(sites.map(s => s.id)).size, sites.length);
  const cabinets = sites.flatMap(s => s.cabinets);
  assert.ok(cabinets.some(c => c.role === 'Sync' && c.type === 'Sync'));
  assert.ok(cabinets.some(c => c.role === 'Satellite' && c.type === 'Satellite'));
  assert.ok(cabinets.every(c => ['Sync', 'Satellite'].includes(c.role)));
  assert.ok(cabinets.every(c => ['Sync', 'Satellite'].includes(c.type)));
  for (const site of sites) for (const cabinet of site.cabinets) {
    if (cabinet.peer !== 'None specified') assert.ok(site.cabinets.some(peer => peer.id === cabinet.peer), 'demo ping peer must be at the same site');
  }
  assert.equal(sites[0].cabinets[0].name, 'Triage cabinet');
  assert.equal(sites[0].cabinets[1].name, 'Treatment cabinet');
});

test('finder filters client, site and cabinet IDs and workspace links sample evidence per cabinet', async () => {
  const { dom, d, route } = await page();
  try {
    assert.equal(d.querySelector('h1').textContent, 'Demo');
    assert.match(d.querySelector('.brand').textContent, /Mashura.*Demo/s);
    const input = d.querySelector('#finder-search');
    for (const [query, expected] of [['CL-202', 'CAB-05'], ['ST-110', 'CAB-01'], ['CAB-02', 'CAB-02']]) {
      input.value = query;
      input.dispatchEvent(new dom.window.Event('input'));
      assert.ok(d.querySelector(`.cabinet-row[href="#cabinet/${expected}"]`));
    }
    route('#cabinet/CAB-02');
    assert.match(d.querySelector('.context').textContent, /CL-101.*ST-110.*Satellite.*Satellite/s);
    assert.match(d.querySelector('.evidence').textContent, /Event Viewer.*Application restart clue.*Disabled \(sample\)/s);
    assert.match(d.querySelector('.evidence').textContent, /sample.*not.*live/s);
    route('#cabinet/CAB-01');
    assert.doesNotMatch(d.querySelector('.evidence').textContent, /Application restart clue/);
    assert.match(d.querySelector('.evidence').textContent, /Sync retry warning/);
  } finally { dom.window.close(); }
});

test('mock Tier 1 stages manual onboarding, Tier 2 reviews and only Supervisor can simulate approval', async () => {
  const { dom, d, route } = await page();
  try {
    route('#onboarding');
    assert.match(d.querySelector('h1').textContent, /Demo onboarding/);
    assert.match(d.querySelector('#onboarding-state').textContent, /No request staged/);
    assert.equal(d.querySelector('#client-name').required, true);
    assert.equal(d.querySelector('#site-name').required, true);
    assert.equal(d.querySelector('#department').required, false);
    assert.equal(d.querySelector('#cabinet-type').disabled, true);
    d.querySelector('#onboarding-cabinet').value = 'CAB-02';
    d.querySelector('#onboarding-cabinet').dispatchEvent(new dom.window.Event('change'));
    assert.equal(d.querySelector('#cabinet-type').value, 'Satellite');
    d.querySelector('#onboarding-cabinet').value = 'CAB-01';
    d.querySelector('#onboarding-cabinet').dispatchEvent(new dom.window.Event('change'));
    for (const id of ['new-client', 'new-site', 'new-cabinet']) assert.ok(d.getElementById(id).labels.length, `${id} has an accessible label`);
    d.querySelector('#client-name').value = 'Veterinary Emergency Group (VEG)';
    d.querySelector('#site-name').value = 'VEG Phoenix';
    d.querySelector('#department').value = 'Demo reception';
    d.querySelector('#stage-request').click();
    assert.match(d.querySelector('#onboarding-state').textContent, /Pending supervisor approval/);
    assert.match(d.querySelector('#onboarding-state').textContent, /CAB-01/);
    assert.match(d.querySelector('#onboarding-state').textContent, /VEG Phoenix.*Demo reception/);
    assert.equal(d.querySelector('#approve-request').disabled, true);
    d.querySelector('#role-view').value = 'Tier 2';
    d.querySelector('#role-view').dispatchEvent(new dom.window.Event('change'));
    assert.equal(d.querySelector('#approve-request').disabled, true);
    assert.match(d.querySelector('#role-guidance').textContent, /Tier 2.*review.*escalate/i);
    d.querySelector('#role-view').value = 'Supervisor';
    d.querySelector('#role-view').dispatchEvent(new dom.window.Event('change'));
    assert.equal(d.querySelector('#approve-request').disabled, false);
    d.querySelector('#approve-request').click();
    assert.match(d.querySelector('#onboarding-state').textContent, /Demo approved/);
    route('#cabinet/CAB-01');
    assert.match(d.querySelector('.context').textContent, /Department.*Demo reception/s);
    route('#onboarding');
    assert.equal(d.querySelector('#approve-request').disabled, true);
    assert.match(d.querySelector('#onboarding-boundary').textContent, /no account.*no authentication.*no server/i);
  } finally { dom.window.close(); }
});

test('mock staff tier changes survive route navigation within this browser session', async () => {
  const { dom, d, route } = await page();
  try {
    route('#onboarding');
    const tier = d.querySelector('#staff-tier');
    assert.equal(tier.value, 'Tier 1');
    tier.value = 'Tier 2'; tier.dispatchEvent(new dom.window.Event('change'));
    route('#finder'); route('#onboarding');
    assert.equal(d.querySelector('#staff-tier').value, 'Tier 2');
    assert.match(d.querySelector('#staff-boundary').textContent, /mock.*not.*entitlements/i);
  } finally { dom.window.close(); }
});

test('onboarding branches new client, site and cabinet without crossing a client boundary', async () => {
  const { dom, d, route } = await page();
  try {
    route('#onboarding');
    d.querySelector('#client-name').value = '__new'; d.querySelector('#client-name').dispatchEvent(new dom.window.Event('change'));
    assert.equal(d.querySelector('#new-client').hidden, false);
    d.querySelector('#new-client').value = 'Demo veterinary group';
    d.querySelector('#site-name').value = '__new'; d.querySelector('#site-name').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#new-site').value = 'Demo clinic north';
    d.querySelector('#onboarding-cabinet').value = '__new'; d.querySelector('#onboarding-cabinet').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#new-cabinet').value = 'CAB-06';
    d.querySelector('#cabinet-type').value = 'Satellite';
    d.querySelector('#stage-request').click();
    assert.match(d.querySelector('#onboarding-state').textContent, /Demo veterinary group.*Demo clinic north.*CAB-06.*Satellite/s);
    route('#finder'); route('#onboarding');
    assert.match(d.querySelector('#onboarding-state').textContent, /Pending supervisor approval/);
    d.querySelector('#role-view').value = 'Supervisor'; d.querySelector('#role-view').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#approve-request').click();
    route('#finder');
    assert.match(d.querySelector('.site-list').textContent, /Demo veterinary group.*Demo clinic north.*CAB-06/s);
    route('#cabinet/CAB-06'); assert.match(d.querySelector('.context').textContent, /Satellite/);
    route('#onboarding'); d.querySelector('#reset-request').click();
    assert.match(d.querySelector('#onboarding-state').textContent, /No request staged/);
    d.querySelector('#client-name').value = 'Demo veterinary group'; d.querySelector('#client-name').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#site-name').value = 'Demo clinic north'; d.querySelector('#site-name').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#onboarding-cabinet').value = '__new'; d.querySelector('#onboarding-cabinet').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#new-cabinet').value = 'CAB-07'; d.querySelector('#stage-request').click();
    d.querySelector('#role-view').value = 'Supervisor'; d.querySelector('#role-view').dispatchEvent(new dom.window.Event('change')); d.querySelector('#approve-request').click();
    route('#cabinet/CAB-06'); assert.equal(d.querySelectorAll('.siblings a').length, 2);
  } finally { dom.window.close(); }
});

test('onboarding rejects cross-client site assignment', async () => {
  const { dom, d, route } = await page();
  try {
    route('#onboarding');
    d.querySelector('#client-name').value = 'Cedar Learning (synthetic)';
    d.querySelector('#client-name').dispatchEvent(new dom.window.Event('change'));
    assert.equal([...d.querySelector('#site-name').options].some(o => o.textContent === 'VEG Phoenix'), false);
    d.querySelector('#site-name').value = 'VEG Phoenix';
    d.querySelector('#stage-request').click();
    assert.match(d.querySelector('#onboarding-state').textContent, /Choose a client and site matching/);
  } finally { dom.window.close(); }
});

test('a site name may repeat under another client', async () => {
  const { dom, d, route } = await page();
  try {
    route('#onboarding');
    d.querySelector('#client-name').value = 'Cedar Learning (synthetic)';
    d.querySelector('#client-name').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#site-name').value = '__new';
    d.querySelector('#site-name').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#new-site').value = 'VEG Phoenix';
    d.querySelector('#onboarding-cabinet').value = '__new';
    d.querySelector('#onboarding-cabinet').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#new-cabinet').value = 'CAB-06';
    d.querySelector('#stage-request').click();
    assert.match(d.querySelector('#onboarding-state').textContent, /Pending supervisor approval/);
    d.querySelector('#role-view').value = 'Supervisor';
    d.querySelector('#role-view').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#approve-request').click();
    route('#finder');
    assert.match(d.querySelector('.site-list').textContent, /Cedar Learning \(synthetic\) \/ VEG Phoenix.*CAB-06/s);
  } finally { dom.window.close(); }
});

test('case-variant client name is refused before staging', async () => {
  const { dom, d, route } = await page();
  try {
    route('#onboarding');
    d.querySelector('#client-name').value = '__new';
    d.querySelector('#client-name').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#new-client').value = 'veterinary emergency group (veg)';
    d.querySelector('#site-name').value = '__new';
    d.querySelector('#site-name').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#new-site').value = 'Another site';
    d.querySelector('#onboarding-cabinet').value = '__new';
    d.querySelector('#onboarding-cabinet').dispatchEvent(new dom.window.Event('change'));
    d.querySelector('#new-cabinet').value = 'CAB-06';
    d.querySelector('#stage-request').click();
    assert.match(d.querySelector('#onboarding-state').textContent, /unique new demo identities/);
  } finally { dom.window.close(); }
});

test('VEG demo scenario uses public city labels and separate synthetic network, driver, firewall and ping clues', async () => {
  const veg = clients.find(c => c.id === 'CL-101');
  assert.equal(veg.name, 'Veterinary Emergency Group (VEG)');
  assert.deepEqual(sites.filter(s => s.clientId === veg.id).map(s => s.name), ['VEG Phoenix', 'VEG Arrowhead', 'VEG Chandler']);
  const { dom, d, route } = await page();
  try {
    route('#cabinet/CAB-01');
    assert.match(d.querySelector('.evidence').textContent, /Network \/ IP.*Driver.*cabinet-to-cabinet ping/s);
    assert.match(d.querySelector('.evidence').textContent, /192\.0\.2\./);
    assert.match(d.querySelector('.evidence').textContent, /Sample observation.*not executed/s);
    assert.match(d.querySelector('.evidence').textContent, /Ping.*cannot establish firewall cause/s);
    assert.match(d.body.textContent, /Demo scenario: VEG.*not evidence.*serves VEG/s);
  } finally { dom.window.close(); }
});

