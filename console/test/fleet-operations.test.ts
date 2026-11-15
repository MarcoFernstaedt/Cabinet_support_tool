import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Compile the production status component in memory: Node's type stripping cannot load TSX,
// and rendering this component needs neither browser globals nor the page's network requests.
const source = readFileSync(new URL("../src/pages/FleetOperations.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("FleetOperations.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const status = file.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === "FleetSelectionStatus");
assert.ok(status);
const limit = file.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(file) === "LIMIT"));
assert.ok(limit);
const compiled = ts.transpileModule(`${limit.getText(file)}\n${status.getText(file)}`, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const exports: { FleetSelectionStatus?: React.ComponentType<any> } = {};
new Function("require", "exports", compiled)(createRequire(import.meta.url), exports);
const render = (limits?: { shown: number; matched: number; limit: number }) => renderToStaticMarkup(createElement(exports.FleetSelectionStatus!, { selected: 3, siteCabinets: 3412, limits }));

test("a cut cabinet list names both counts and tells the operator how to narrow it", () => {
  const html = render({ shown: 200, matched: 3412, limit: 200 });
  assert.match(html, /role="note"/);
  assert.match(html, /200 of 3,412 cabinets/);
  assert.match(html, /Narrow by client, site or problem/);
  assert.match(html, /3<\/strong> cabinets selected; list is cut/);
  assert.doesNotMatch(html, /of 3412 selected/);
});

for (const n of [0, 7, 200]) test(`an uncut cabinet list needs no truncation note (${n} shown)`, () => {
  const html = render({ shown: n, matched: n, limit: 200 });
  assert.doesNotMatch(html, /role="note"|list is cut|Narrow by/);
  assert.match(html, /3<\/strong> of 3412 selected/);
});

test("before the cabinet list loads there is no truncation claim", () => {
  assert.doesNotMatch(render(), /role="note"|list is cut/);
});
