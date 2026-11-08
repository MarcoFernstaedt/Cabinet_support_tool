// The pasted list of clients and sites (F6.R4) read into import rows: commas, tabs, quotes, a heading, and lines that are not rows.
import test from "node:test";
import assert from "node:assert/strict";
import { parseImport, splitLine } from "../src/lib/import-rows.ts";

test("lines become rows: commas or tabs, quoted commas, a heading and blank lines skipped, names trimmed", () => {
  const r = parseImport('Client, Site\n\nHarbour Health, Pier\n"Smith, Jones Clinic" , "North ""A"""\nInland\tSouth Wing\r\n');
  assert.deepEqual(r.rows, [{ client: "Harbour Health", site: "Pier" }, { client: "Smith, Jones Clinic", site: 'North "A"' }, { client: "Inland", site: "South Wing" }]);
  assert.deepEqual(r.problems, []);
});

test("a line without exactly a client and a site is named by its line number, not dropped silently", () => {
  const r = parseImport("Harbour, Pier\nOnly a client\nA, B, C\n, Site\nOK, Fine");
  assert.deepEqual(r.rows.map(x => x.site), ["Pier", "Fine"]);
  assert.deepEqual(r.problems.map(p => p.line), [2, 3, 4]);
});

test("a heading is only skipped on the first line", () => {
  assert.deepEqual(parseImport("A, B\nclient, site").rows.length, 2);
  assert.deepEqual(splitLine('"unclosed, quote'), ["unclosed, quote"]);
});
