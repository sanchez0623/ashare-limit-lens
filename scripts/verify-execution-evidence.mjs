import { readFileSync } from "node:fs";
import { verifyExecutionStress } from "../backend/domain/execution-stress.js";
import { verifyExecutionCalibration } from "../backend/domain/execution-calibration.js";

const path = process.argv[2];
if (!path) {
  console.error(
    "用法：node scripts/verify-execution-evidence.mjs <压力或校准导出.json>",
  );
  process.exitCode = 1;
} else {
  try {
    const bundle = JSON.parse(readFileSync(path, "utf8"));
    const audit = bundle.id?.startsWith("stress-")
      ? await verifyExecutionStress(bundle)
      : await verifyExecutionCalibration(bundle);
    console.log(JSON.stringify(audit));
  } catch (error) {
    console.error(`核验失败：${error.message}`);
    process.exitCode = 1;
  }
}
