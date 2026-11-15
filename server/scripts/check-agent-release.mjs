// Run after npm run build: node server/scripts/check-agent-release.mjs <release-dir> windows-x64|windows-x86
// Read-only evidence against the server verifier and repository pins; uploading still requires the database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { checkManifest, ReleaseKeys } from '../dist/src/services/releases.js';
import { packageArchitecture, missingReleasePrograms } from '../dist/src/services/package-architecture.js';
const [folder, architecture] = process.argv.slice(2);
assert.ok(folder && ['windows-x64', 'windows-x86'].includes(architecture), 'Supply a release directory and windows-x64|windows-x86');
const bytes = readFileSync(join(folder, 'manifest.json'));
const signature = JSON.parse(readFileSync(join(folder, 'signature.json'), 'utf8'));
const keys = ReleaseKeys.fromFolder();
const { manifest } = checkManifest(keys, bytes.toString('base64'), signature);
const zip = readFileSync(join(folder, `agent-${manifest.version}.zip`));
assert.equal(createHash('sha256').update(zip).digest('hex'), manifest.sha256);
assert.equal(zip.length, manifest.sizeBytes);
assert.equal(packageArchitecture(zip), architecture);
assert.deepEqual(missingReleasePrograms(zip), []);
assert.throws(() => checkManifest(keys, Buffer.concat([bytes, Buffer.from(' ')]).toString('base64'), signature));
assert.throws(() => checkManifest(keys, bytes.toString('base64'), { ...signature, signature: '' }));
console.log(`Accepted ${manifest.version} ${architecture}: pinned manifest signature, package hash/size and architecture; changed/absent signature refused.`);
