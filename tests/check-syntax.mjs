import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
const walk = directory => {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) files.push(full);
  }
};
walk(path.join(root, "src"));
walk(path.join(root, "tests"));
for (const file of files) {
  execFileSync(process.execPath, ["--check", file], {stdio: "inherit"});
}
console.log(`Syntax OK: ${files.length} files`);
