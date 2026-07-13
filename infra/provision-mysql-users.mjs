#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [adminUrlFile, outputDirectory] = process.argv.slice(2);
if (!adminUrlFile || !outputDirectory) {
  throw new Error("Usage: provision-mysql-users.mjs ADMIN_URL_FILE OUTPUT_DIRECTORY");
}

const adminUrl = new URL((await readFile(resolve(adminUrlFile), "utf8")).trim());
const database = decodeURIComponent(adminUrl.pathname.slice(1));
if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error("Unsafe database name.");

const accounts = {
  runtime: { user: "track_the_hack_app", password: randomBytes(32).toString("hex") },
  migrator: { user: "track_the_hack_migrator", password: randomBytes(32).toString("hex") },
  prisma: { user: "track_the_hack_prisma", password: randomBytes(32).toString("hex") },
};

await mkdir(resolve(outputDirectory), { recursive: true, mode: 0o700 });
const writeSecret = (name, value) => writeFile(resolve(outputDirectory, name), value, { mode: 0o600 });
await writeSecret("admin.cnf", [
  "[client]",
  `host=${adminUrl.hostname}`,
  `port=${adminUrl.port || "3306"}`,
  `user=${decodeURIComponent(adminUrl.username)}`,
  `password=${decodeURIComponent(adminUrl.password)}`,
  "ssl-mode=VERIFY_IDENTITY",
  "ssl-ca=/run/host-ca-certificates.crt",
  "",
].join("\n"));

const statements = Object.values(accounts).flatMap(({ user, password }) => [
  `CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${password}';`,
  `ALTER USER '${user}'@'%' IDENTIFIED BY '${password}';`,
]);
statements.push(
  `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${database}\`.* TO '${accounts.runtime.user}'@'%';`,
  `GRANT ALL PRIVILEGES ON \`${database}\`.* TO '${accounts.migrator.user}'@'%';`,
  `GRANT SELECT ON \`${database}\`.* TO '${accounts.prisma.user}'@'%';`,
  "FLUSH PRIVILEGES;",
);
await writeSecret("provision.sql", `${statements.join("\n")}\n`);

for (const [name, account] of Object.entries(accounts)) {
  const url = new URL(adminUrl);
  url.username = account.user;
  url.password = account.password;
  await writeSecret(`${name}-database-url`, url.toString());
}
