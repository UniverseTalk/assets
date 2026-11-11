// Build src-images/ into dist/. See README.md and scripts/pipeline.mjs.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { build, SourceError } from "./pipeline.mjs";

const srcDir = "src-images";
const outDir = "dist";

function problem(e) {
  const inSrc = e.file !== "images.config.json";
  const file = inSrc ? path.join(srcDir, e.file) : e.file;
  const message = e.message.slice(e.file.length + 2);
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::error file=${file},title=Image problem::${file}: ${message}`);
  console.error(`\nIMAGE PROBLEM  ${file}\n  ${message}`);
}

try {
  const { manifest, errors } = await build({ srcDir, outDir, configPath: "images.config.json", log: console.log });
  if (errors.length) {
    errors.forEach(problem);
    console.error(`\n${errors.length} image problem(s). Nothing is published. Fix the file(s) named above and push again.`);
    process.exit(1);
  }
  console.log("\nsizes in bytes:");
  for (const name of Object.keys(manifest.images)) {
    const files = (await readdir(path.join(outDir, name), { recursive: true, withFileTypes: true })).filter((d) => d.isFile());
    for (const d of files.sort((a, b) => a.parentPath.localeCompare(b.parentPath) || parseInt(a.name) - parseInt(b.name) || a.name.localeCompare(b.name))) {
      const file = path.join(d.parentPath, d.name);
      console.log(`  /${path.relative(outDir, file).padEnd(40)} ${String((await stat(file)).size).padStart(8)}`);
    }
  }
} catch (e) {
  if (!(e instanceof SourceError)) throw e;
  problem(e);
  process.exit(1);
}
