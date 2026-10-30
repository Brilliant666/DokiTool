import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const localPhp = fileURLToPath(
  new URL("../../.tools/php-8.4.27-1/php.exe", import.meta.url),
);
const phpBinary =
  process.env.DOKITOOL_PHP_BINARY || (existsSync(localPhp) ? localPhp : "php");
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-concurrency=1",
    "--test-name-pattern=PR8 integration:",
    fileURLToPath(
      new URL("../tests/ui-download-contract.test.mjs", import.meta.url),
    ),
  ],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
    env: {
      ...process.env,
      DOKITOOL_MEDIA_INTEGRATION: "1",
      DOKITOOL_PHP_BINARY: phpBinary,
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
