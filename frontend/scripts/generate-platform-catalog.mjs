import { readFile, writeFile, mkdir } from "node:fs/promises";
const registry = JSON.parse(
  await readFile(
    new URL("../../backend/config/platforms.json", import.meta.url),
    "utf8",
  ),
);
const platforms = registry.map(
  ({ id, name, site_url, icon, capabilities }) => ({
    id,
    name,
    site_url,
    ...(icon ? { icon } : {}),
    capabilities,
  }),
);
const output = new URL(
  "../src/generated/platform-catalog.json",
  import.meta.url,
);
await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    { schema_version: "1.0", code: "OK", data: { platforms } },
    null,
    2,
  ) + "\n",
);
