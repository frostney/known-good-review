import { resolve } from "node:path";
import { replayLifecycle } from "../src/telemetry/replay";

const fixturePath = resolve(
  Bun.argv[2] ?? "tests/fixtures/pascal-mcp-sdk-pr-61-runs.json",
);
const fixture = await Bun.file(fixturePath).json();
const report = replayLifecycle(fixture);

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
