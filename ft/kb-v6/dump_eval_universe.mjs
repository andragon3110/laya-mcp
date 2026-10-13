/** kb-v6: dump the 220-id+text eval universe (r1-60 + v2-80 + batch4-80). Read-only. */
import { writeFileSync } from "node:fs";
import * as r1c from "../../evals/corpus-r1/classify.mjs";
import * as r1s from "../../evals/corpus-r1/screen.mjs";
import * as r1g from "../../evals/corpus-r1/gate.mjs";
import * as r1r from "../../evals/corpus-r1/rerank.mjs";
import * as r1f from "../../evals/corpus-r1/find.mjs";
import * as v2c from "../../evals/corpus-v2/classify.mjs";
import * as v2g from "../../evals/corpus-v2/gate.mjs";
import * as v2s from "../../evals/corpus-v2/screen.mjs";
import * as b4c from "../../evals/corpus-batch4/classify.mjs";
import * as b4g from "../../evals/corpus-batch4/gate.mjs";
import * as b4s from "../../evals/corpus-batch4/screen.mjs";

const mods = [r1c, r1s, r1g, r1r, r1f, v2c, v2g, v2s, b4c, b4g, b4s];
const ids = [];
const texts = [];
for (const m of mods) {
  for (const c of m.cases) {
    ids.push(c.id);
    texts.push(JSON.stringify(c.input));
  }
}
console.log("total:", ids.length);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) { console.error("DUP IDS", dupes); process.exit(1); }
writeFileSync(new URL("./eval-universe.json", import.meta.url), JSON.stringify({ ids, texts }, null, 1) + "\n");
console.log("wrote eval-universe.json:", ids.length, "ids +", texts.length, "texts");
