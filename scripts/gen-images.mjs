import sharp from "sharp";
import { globby } from "globby";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const widths = [320, 640, 960, 1280];
const formats = ["webp", "avif"];

await rm("dist", { recursive: true, force: true });
const srcs = await globby("src-images/*.{png,jpg,jpeg,svg}");
for (const file of srcs) {
  const name = path.basename(file).replace(/\.\w+$/, "");
  const outDir = path.join("dist", name);
  await mkdir(outDir, { recursive: true });
  for (const w of widths) {
    for (const f of formats) {
      await sharp(file, { density: 300 })
        .resize(w)
        .toFormat(f, { quality: 72 })
        .toFile(path.join(outDir, `${w}.${f}`));
    }
  }
  console.log("built", name, "->", widths.length * formats.length, "files");
}
