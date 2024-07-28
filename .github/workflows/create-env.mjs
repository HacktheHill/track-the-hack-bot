#!/usr/bin/env node
import { writeFileSync } from "fs";

console.info("Creating .env file...");

const secrets = JSON.parse(process.argv[2]);
const vars = JSON.parse(process.argv[3]);

console.log("Secrets:", secrets);
console.log("Vars:", vars);

const env = { ...secrets, ...vars };

const envFile = Object.keys(env)
    .map((key) => `${key.replace(/^_+/, "")}=${env[key]}`)
    .join("\n");

writeFileSync(".env", envFile);

console.info(".env file created.");
