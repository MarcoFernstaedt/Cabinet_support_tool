import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createDemoServer } from "../demo-server.mjs";
import { sites, modules, scannerTypes } from "../demo-data.mjs";

async function withServer(run) {
  const server = createDemoServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test("fictional fixture has unique navigable cabinets and three scanner families", () => {
  const cabinets = sites.flatMap(site => site.cabinets);
  assert.equal(new Set(cabinets.map(item => item.id)).size, cabinets.length);
  assert.deepEqual(new Set(cabinets.map(item => item.type)), new Set(scannerTypes));
  assert.deepEqual(modules.map(item => item.id), ["identity", "connectivity", "events", "fingerprint"]);
  assert.ok(cabinets.every(item => item.id.startsWith("CAB-")));
});
test("finder, site navigation and independently selectable not-run modules work without requests", async () => {
  const html = await readFile(new URL("../demo.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../demo-app.mjs", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:4174/", runScripts: "dangerously" });
  try {
    dom.window.eval(`const sites = ${JSON.stringify(sites)}; const modules = ${JSON.stringify(modules)}; const scannerTypes = ${JSON.stringify(scannerTypes)};\n` + script.replace(/^import .*;\s*/, ""));
    const { document: d } = dom.window;
    assert.match(d.querySelector("h1").textContent, /Find a cabinet/);
    const input = d.querySelector("#finder-search");
    input.value = "Harbor";
    input.dispatchEvent(new dom.window.Event("input"));
    assert.match(d.querySelector("#finder-count").textContent, /2 fictional cabinets across 1 site/);
    assert.equal(d.querySelectorAll(".cabinet-row").length, 2);
    input.value = "no such cabinet";
    input.dispatchEvent(new dom.window.Event("input"));
    assert.match(d.querySelector(".empty").textContent, /No matching/);
    dom.window.location.hash = "#cabinet/CAB-01";
    dom.window.dispatchEvent(new dom.window.Event("hashchange"));
    assert.match(d.querySelector(".context").textContent, /Harbor Arcade/);
    assert.match(d.querySelector(".module-detail").textContent, /All checks/);
    d.querySelector('[data-module="fingerprint"]').click();
    assert.match(d.querySelector(".module-detail").textContent, /Script and allowlisted output fields are pending/);
    assert.match(d.querySelector(".module-detail").textContent, /Not run · No result available/);
    assert.match(d.querySelector(".family.current").textContent, /Scanner A/);
    dom.window.location.hash = "#cabinet/CAB-02";
    dom.window.dispatchEvent(new dom.window.Event("hashchange"));
    assert.match(d.querySelector(".family.current").textContent, /Scanner B/);
    assert.equal(d.querySelectorAll(".siblings a").length, 2);
    d.querySelector('[data-module="connectivity"]').click();
    assert.match(d.querySelector(".module-detail").textContent, /failed probe alone cannot identify a cause/);
    assert.equal(d.querySelectorAll("form").length, 0);
    assert.equal(d.querySelectorAll("[onclick]").length, 0);
  } finally { dom.window.close(); }
});

test("demo serves only allowlisted static fictional assets with restrictive headers", async () => {
  await withServer(async origin => {
    for (const path of ["/", "/demo.css", "/demo-app.mjs", "/demo-data.mjs"]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-security-policy"), /connect-src 'none'/);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    const page = await (await fetch(origin)).text();
    assert.match(page, /FICTIONAL DEMO DATA/);
    assert.match(page, /No live results/);
    assert.equal((await fetch(origin + "/cabinet/CAB-01")).status, 404);
    assert.equal((await fetch(origin + "/server.mjs")).status, 404);
    assert.equal((await fetch(origin, { method: "POST" })).status, 404);
    const hostStatus = await new Promise((resolve, reject) => {
      http.get(origin, { headers: { Host: "example.com" } }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    assert.equal(hostStatus, 421);
  });
});
