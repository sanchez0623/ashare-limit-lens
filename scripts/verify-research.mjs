import { readFileSync } from "node:fs";
import { verifyResearchExport } from "../backend/domain/research-verifier.js";
try {
  if (!process.argv[2])
    throw new Error("用法：npm run verify:research -- <研究导出.json>");
  const result = await verifyResearchExport(
    JSON.parse(readFileSync(process.argv[2], "utf8")),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`研究核验失败：${error.message}`);
  process.exitCode = 1;
}
