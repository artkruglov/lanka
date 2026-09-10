import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function configuration(c) {
  const required = [
    "cloudflare.accountId",
    "cloudflare.workerName",
    "cloudflare.hostname",
    "cloudflare.d1DatabaseId",
    "cloudflare.d1DatabaseName",
    "cloudflare.r2BucketName",
    "access.teamDomain",
    "access.audience",
    "access.workerId",
    "access.workerEmail",
    "fly.appName",
    "fly.primaryRegion",
  ];
  for (const key of required) {
    const [area, name] = key.split(".");
    if (typeof c[area]?.[name] !== "string" || !c[area][name])
      throw new Error(`Fill ${key}`);
  }
  for (const value of [
    c.cloudflare.workerName,
    c.cloudflare.d1DatabaseName,
    c.cloudflare.r2BucketName,
    c.fly.appName,
    c.access.workerId,
  ])
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(value))
      throw new Error("Invalid resource name");
  if (
    !/^[a-f0-9]{32}$/.test(c.cloudflare.accountId) ||
    !/^[a-f0-9-]{36}$/.test(c.cloudflare.d1DatabaseId)
  )
    throw new Error("Use real account/database IDs");
  if (
    !/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(c.cloudflare.hostname) ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(
      c.access.teamDomain,
    ) ||
    !/^\S+@\S+\.\S+$/.test(c.access.workerEmail) ||
    !/^[a-z]{3}$/.test(c.fly.primaryRegion)
  )
    throw new Error("Invalid hostname, Access domain, worker email or region");
  const wrangler = {
    name: c.cloudflare.workerName,
    account_id: c.cloudflare.accountId,
    main: "../deploy/cloudflare-entry.mjs",
    compatibility_date: "2026-09-05",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    assets: {
      directory: "../dist/client",
      binding: "ASSETS",
      run_worker_first: true,
    },
    routes: [{ pattern: c.cloudflare.hostname, custom_domain: true }],
    d1_databases: [
      {
        binding: "DB",
        database_name: c.cloudflare.d1DatabaseName,
        database_id: c.cloudflare.d1DatabaseId,
        migrations_dir: "../drizzle",
      },
    ],
    r2_buckets: [{ binding: "BUCKET", bucket_name: c.cloudflare.r2BucketName }],
    vars: {
      ACCESS_TEAM_DOMAIN: c.access.teamDomain,
      ACCESS_AUD: c.access.audience,
      LANKA_WORKER_ID: c.access.workerId,
      LANKA_WORKER_EMAIL: c.access.workerEmail,
    },
  };
  const fly = `app = ${JSON.stringify(c.fly.appName)}\nprimary_region = ${JSON.stringify(c.fly.primaryRegion)}\nkill_signal = "SIGTERM"\nkill_timeout = "30s"\n\n[build]\n  dockerfile = "Dockerfile"\n\n[processes]\n  worker = "node worker.mjs"\n\n[env]\n  LANKA_MCP_URL = ${JSON.stringify(`https://${c.cloudflare.hostname}/api/mcp`)}\n  LANKA_PYTHON = "python3"\n\n[[vm]]\n  memory = "1gb"\n  cpu_kind = "shared"\n  cpus = 1\n  processes = ["worker"]\n\n[[restart]]\n  policy = "on-failure"\n  retries = 5\n  processes = ["worker"]\n`;
  return { wrangler, fly };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (!process.argv[2])
      throw new Error("Provide a filled external JSON configuration file");
    const c = configuration(
      JSON.parse(await readFile(process.argv[2], "utf8")),
    );
    await mkdir(resolve(root, ".external"), { recursive: true });
    await writeFile(
      resolve(root, ".external/wrangler.json"),
      JSON.stringify(c.wrangler, null, 2) + "\n",
    );
    await writeFile(resolve(root, ".external/fly.toml"), c.fly);
    process.stdout.write(
      "Validated configuration written. No cloud resources were changed.\n",
    );
  } catch (e) {
    process.stderr.write(e.message + "\n");
    process.exitCode = 1;
  }
}
