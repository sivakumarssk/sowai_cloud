// sowsi-gateway, run in bash against a faked container (src/lib/testing/fakeGatewayNode.ts): the
// table's size limits. A file of its own: 5,000 lines take a while in bash on Windows.
import assert from "node:assert/strict";
import { K1, runGateway, unchanged, whenBash } from "@/lib/testing/fakeGatewayNode";

whenBash("the table is limited in size: 5,000 lines and 1 MiB", () => {
  const line = (i: number) => `h${i}.example.com ${K1} 100.64.0.5 0\n`;
  const atLimit = Array.from({ length: 5000 }, (_, i) => line(i)).join("");
  const r = runGateway({ args: "sync 6", stdin: atLimit });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /5000 routes/);
  const over = runGateway({ args: "sync 6", stdin: atLimit + line(5000) });
  assert.equal(over.status, 2);
  assert.match(over.stderr, /over 5000 lines/);
  unchanged(over, "5,001 lines");
  const big = runGateway({ args: "sync 6", stdin: "a".repeat(1048577) });
  assert.equal(big.status, 2);
  assert.match(big.stderr, /over 1048576 bytes/);
  unchanged(big, "over 1 MiB");
});
