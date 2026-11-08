const fs = require('fs');

// 1) golden test: count literal literal entries and set counts to main+1 (606)
const gp = 'packages/db/src/lib/tenantTableManifest.golden.test.ts';
let g = fs.readFileSync(gp, 'utf8');
const lit = g.match(/const literal: readonly string\[\] = \[([\s\S]*?)\];/);
if (lit) {
  const names = (lit[1].match(/"[^"]+"/g) || []).map((s) => s.slice(1, -1));
  console.log('golden literal entries:', names.length, 'unique:', new Set(names).size);
} else {
  console.log('golden literal array not found (conflict may span it)');
}
g = g
  .replace(/it\('has 601 unique ordered names'/, "it('has 606 unique ordered names'")
  .replace(/expect\(order\)\.toHaveLength\(601\)/, 'expect(order).toHaveLength(606)')
  .replace(/expect\(new Set\(order\)\.size\)\.toBe\(601\)/, 'expect(new Set(order).size).toBe(606)');
fs.writeFileSync(gp, g);
console.log('golden test counts set to 606');

// 2) temporal manifest test: take origin/main side (606)
const qp = 'ee/temporal-workflows/src/db/__tests__/tenantTableManifest.test.ts';
const lines = fs.readFileSync(qp, 'utf8').split(/\r?\n/);
let ai = -1, mi = -1, zi = -1;
lines.forEach((l, i) => {
  if (ai < 0 && l.startsWith('<<<<<<<')) ai = i;
  else if (ai >= 0 && mi < 0 && l.startsWith('=======')) mi = i;
  else if (mi >= 0 && zi < 0 && l.startsWith('>>>>>>>')) zi = i;
});
if (ai >= 0) {
  const out = [...lines.slice(0, ai), ...lines.slice(mi + 1, zi), ...lines.slice(zi + 1)];
  fs.writeFileSync(qp, out.join('\n') + '\n');
  console.log('temporal test: took main side');
} else {
  console.log('temporal test: no markers');
}
