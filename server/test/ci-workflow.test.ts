// The Windows CI run finds the runner's default-route adapter without Get-NetIPConfiguration (decision-log D159): on some runners that
// cmdlet throws "Cannot convert System.Object[] to CimInstance" before anything reaches the agent, and it failed the job twice (#347,
// #352). The lookup it uses instead still gives the two things the step reads: the adapter's index and its DNS servers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "platform-contracts.yml"), "utf8");

test("the Windows run does not call Get-NetIPConfiguration, and finds the adapter through the default route", () => {
  assert.equal(workflow.includes("Get-NetIPConfiguration"), false);
  assert.match(workflow, /Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0\.0\.0\.0\/0'/);
  assert.match(workflow, /if \(-not \$route\) \{ throw /, "a runner with no default route fails plainly, not on a null index");
  assert.match(workflow, /\$nic = \[pscustomobject\]@\{ InterfaceIndex = \$route\.ifIndex; DNSServer = @\(Get-DnsClientServerAddress -InterfaceIndex \$route\.ifIndex\) \}/);
  // Everything the step reads from $nic is one of the two members it now has.
  const used = new Set([...workflow.matchAll(/\$nic\.([A-Za-z]+)/g)].map(m => m[1]));
  assert.deepEqual([...used].sort(), ["DNSServer", "InterfaceIndex"]);
});
