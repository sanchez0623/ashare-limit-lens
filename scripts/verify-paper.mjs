import { readFile } from "node:fs/promises";
import { verifyExport } from "../backend/services/paper.js";
const file = process.argv[2];
if (!file) {
  console.error(
    "Usage: npm run verify:paper -- /path/to/limit-lens-paper.json",
  );
  process.exit(2);
}
const result = await verifyExport(JSON.parse(await readFile(file, "utf8")));
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.passed ? 0 : 1;
