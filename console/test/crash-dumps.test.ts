import test from "node:test";
import assert from "node:assert/strict";
import { sizeText, stopCodeText } from "../src/lib/crash-dumps.ts";

test("stop codes read as Windows writes them, and a missing one says why", () => {
  assert.equal(stopCodeText({ stopCode: 0xd1, problem: null }), "0x000000D1");
  assert.equal(stopCodeText({ stopCode: 0xc000021a, problem: null }), "0xC000021A");
  assert.equal(stopCodeText({ stopCode: null, problem: "not_a_dump" }), "Not a crash dump");
  assert.equal(stopCodeText({ stopCode: null, problem: "unreadable" }), "Windows would not open it");
  for (const bad of [-1, 2 ** 32, 1.5, Number.NaN]) assert.equal(stopCodeText({ stopCode: bad, problem: null }), "Not read", String(bad));
});

test("sizes are readable and nonsense is a dash", () => {
  assert.equal(sizeText(262_144), "256 KB");
  assert.equal(sizeText(1_048_576), "1.0 MB");
  assert.equal(sizeText(805_306_368), "768.0 MB");
  assert.equal(sizeText(3 * 1024 ** 3), "3.0 GB");
  assert.equal(sizeText(10), "1 KB");
  for (const bad of [null, undefined, -5, Number.NaN]) assert.equal(sizeText(bad), "—");
});
