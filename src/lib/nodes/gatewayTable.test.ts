// sowsi-gateway, as proxmox-host-setup.sh writes it, run in bash against a faked container
// (src/lib/testing/fakeGatewayNode.ts): which tables and command lines it refuses, before anything changes.
import assert from "node:assert/strict";
import { K1, K2, runGateway, unchanged, whenBash } from "@/lib/testing/fakeGatewayNode";

whenBash("one bad line refuses the whole table, runs nothing it was handed, and changes nothing", () => {
  const ok = `a.example.com ${K1} 100.64.0.5 0`;
  const long = (n: number) => `${"a".repeat(n)}.example.com ${K1} 100.64.0.5 0`;
  const bad: [string, string][] = [
    ["a.example.com;reboot k 100.64.0.5 0", "a shell character"],
    [`$(touch pwned).example.com ${K1} 100.64.0.5 0`, "command substitution"],
    [`\`touch pwned\`.example.com ${K1} 100.64.0.5 0`, "backticks"],
    [`${ok} extra`, "a fifth field"],
    [`a.example.com\t${K1} 100.64.0.5 0`, "a tab"],
    [`a.example.com  ${K1} 100.64.0.5 0`, "two spaces"],
    [` ${ok}`, "a leading space"],
    [`${ok}\r`, "a carriage return"],
    [`${ok}\n\nb.example.com ${K1} 100.64.0.5 0`, "an empty line"],
    [`A.EXAMPLE.COM ${K1} 100.64.0.5 0`, "uppercase"],
    [`*.example.com ${K1} 100.64.0.5 0`, "a wildcard"],
    [`example ${K1} 100.64.0.5 0`, "no dot"],
    [`a.example.com. ${K1} 100.64.0.5 0`, "a trailing dot"],
    [`a..example.com ${K1} 100.64.0.5 0`, "an empty label"],
    [`-a.example.com ${K1} 100.64.0.5 0`, "a label starting with a dash"],
    [`a-.example.com ${K1} 100.64.0.5 0`, "a label ending with a dash"],
    [`a.example.123 ${K1} 100.64.0.5 0`, "a numeric top-level part"],
    [`a.example.c ${K1} 100.64.0.5 0`, "a one-letter top-level part"],
    [long(64), "a 64-character label"],
    [`${"a.".repeat(124)}example.com ${K1} 100.64.0.5 0`, "over 253 characters"],
    [`a.example.com short 100.64.0.5 0`, "a short key"],
    [`a.example.com ${K1}0 100.64.0.5 0`, "a long key"],
    [`a.example.com ../../etc/passwd 100.64.0.5 0`, "a path as the key"],
    [`a.example.com ${K1} 8.8.8.8 0`, "an outside address"],
    [`a.example.com ${K1} 203.0.113.7 0`, "a dedicated container's address"],
    [`a.example.com ${K1} 203.0.113.50 0`, "the gateway's own address"],
    [`a.example.com ${K1} 100.64.0.99 0`, "a shared address with no container on this node"],
    [`a.example.com ${K1} 100.64.0.9 0`, "a shared address on another bridge"],
    [`a.example.com ${K1} 100.064.0.5 0`, "a leading zero"],
    [`a.example.com ${K1} 100.64.0.5 2`, "a PROXY flag that isn't 0 or 1"],
    [`use_backend evil ${K1} 100.64.0.5 0`, "config text as the hostname"],
    [`a.example.com ${K1} 100.64.0.5 0\na.example.com ${K2} 100.64.0.6 0`, "a hostname twice"],
    [`a.example.com ${K1} 100.64.0.5 0\nb.example.com ${K1} 100.64.0.6 0`, "one key, two addresses"],
    [`a.example.com ${K1} 100.64.0.5 0\nb.example.com ${K2} 100.64.0.5 0`, "one address, two keys"],
    [`a.example.com ${K1} 100.64.0.5 0\u0000`, "a NUL byte"],
    [`ä.example.com ${K1} 100.64.0.5 0`, "a non-ASCII character"],
  ];
  for (const [table, why] of bad) {
    const r = runGateway({ args: "sync 6", stdin: `${table}\n` });
    assert.equal(r.status, 2, `${why}: ${r.stderr}`);
    assert.match(r.stderr, /^refused: /m, why);
    assert.equal(r.pwned, false, `${why}: something ran`);
    unchanged(r, why);
  }
});

whenBash("the command line takes one version number and nothing else", () => {
  for (const args of ["sync", "sync abc", "sync 5 6", "sync -1", "sync 1234567890123456", "status extra", "install now", "nothing", ""]) {
    const r = runGateway({ args, stdin: "" });
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stderr}`);
    unchanged(r, args);
  }
});
