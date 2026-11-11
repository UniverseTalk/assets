// Image pipeline v2. Rules (spec: UniverseTalk/ops#1, section A.3):
//   - output /<name>/<hash8>/<width>.<avif|webp>, hash8 = first 8 hex of SHA-256 of the source file
//   - /manifest.json with hash, source width/height, widths and formats per image
//   - never wider than the source; ladder capped at the source width
//   - vector SVG goes through SVGO to /<name>/<hash8>.svg
//   - the previous committed version of every source is built too, so its URLs live one more deploy
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { optimize } from "svgo";

export const DEFAULT_WIDTHS = [320, 480, 640, 960, 1280, 1920];
export const QUALITY = { avif: 50, webp: 75 };
export const FORMATS = ["avif", "webp"]; // AVIF first, WebP is the fallback
const RASTER_EXT = ["png", "jpg", "jpeg", "webp"];
const SUPPORTED_EXT = [...RASTER_EXT, "svg"];

/** An error caused by a source file or the config, written for the person who added the file. */
export class SourceError extends Error {
  constructor(file, message) {
    super(`${file}: ${message}`);
    this.file = file;
  }
}

export function hash8(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 8);
}

/** Widths to build: the ladder, cut off at the source width. The source width itself is the top step when the ladder goes past it. */
export function ladder(sourceWidth, widths = DEFAULT_WIDTHS) {
  const sorted = [...new Set(widths)].sort((a, b) => a - b);
  const kept = sorted.filter((w) => w <= sourceWidth);
  if (kept.length < sorted.length && !kept.includes(sourceWidth)) kept.push(sourceWidth);
  return kept;
}

const attr = (tag, name) => tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
const num = (v) => (v === undefined || !/^-?[\d.]+(px)?$/.test(v.trim()) ? NaN : parseFloat(v));

function svgBox(svg) {
  const root = svg.match(/<svg\b[^>]*>/)?.[0];
  if (!root) return null;
  const vb = attr(root, "viewBox")?.trim().split(/[\s,]+/).map(Number);
  const width = vb?.length === 4 ? vb[2] : num(attr(root, "width"));
  const height = vb?.length === 4 ? vb[3] : num(attr(root, "height"));
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Size, in real pixels, of an SVG that wraps a raster picture (a Figma export: the picture is a
 * pattern fill on a shape). The SVG is rendered so that the picture inside is not enlarged.
 * Returns null for an SVG with no picture inside (a vector icon).
 */
export async function wrappedRasterSize(svg, file = "svg") {
  const uris = [...svg.matchAll(/href="(data:image\/[^"]*)"/g)].map((m) => m[1]);
  if (uris.length === 0) return null;
  const cannot = (why) =>
    new SourceError(file, `this SVG has a picture inside it and the pipeline cannot measure it (${why}). Export the image as PNG or JPG and add that file in place of the SVG.`);
  const skeleton = svg.replace(/href="data:image\/[^"]*"/g, 'href=""');
  const box = svgBox(skeleton);
  if (!box) throw cannot("no viewBox or size on the <svg> element");
  const images = skeleton.match(/<image\b[^>]*>/g) ?? [];
  if (images.length !== uris.length) throw cannot("unexpected <image> elements");

  let scale = Infinity; // real pixels per SVG unit; the smallest one wins so nothing is enlarged
  for (const [i, tag] of images.entries()) {
    const id = attr(tag, "id");
    const base64 = uris[i].match(/^data:image\/[\w.+-]+;base64,(.*)$/s)?.[1];
    if (!id || !base64) throw cannot("picture without id or not base64");
    const natural = await sharp(Buffer.from(base64, "base64")).metadata();
    const attrW = num(attr(tag, "width"));
    const attrH = num(attr(tag, "height"));
    let used = 0;
    for (const pattern of skeleton.matchAll(/<pattern\b([^>]*)>(.*?)<\/pattern>/gs)) {
      const use = pattern[2].match(new RegExp(`<use\\b[^>]*href="#${id}"[^>]*>`))?.[0];
      if (!use) continue;
      if (attr(pattern[1], "patternContentUnits") !== "objectBoundingBox") throw cannot("pattern units");
      const t = attr(use, "transform") ?? "";
      const s = t.match(/^scale\(([^)]*)\)$/)?.[1].trim().split(/[\s,]+/).map(Number);
      const m = t.match(/^matrix\(([^)]*)\)$/)?.[1].trim().split(/[\s,]+/).map(Number);
      let sx, sy;
      if (s) [sx, sy = sx] = s;
      else if (m?.length === 6 && m[1] === 0 && m[2] === 0) [sx, , , sy] = m;
      if (!(sx > 0 && sy > 0)) throw cannot(`transform "${t}"`);
      const pid = attr(pattern[1], "id");
      for (const shape of skeleton.matchAll(/<(?!pattern)\w+\b[^>]*>/g)) {
        if (attr(shape[0], "fill") !== `url(#${pid})`) continue;
        const w = num(attr(shape[0], "width"));
        const h = num(attr(shape[0], "height"));
        if (!(w > 0 && h > 0) || attr(shape[0], "transform")) throw cannot("shape that shows the picture");
        scale = Math.min(scale, natural.width / (w * sx * attrW), natural.height / (h * sy * attrH));
        used++;
      }
    }
    if (used === 0) throw cannot("picture is not a pattern fill");
  }
  if (/<g\b[^>]*\stransform=/.test(skeleton) || !Number.isFinite(scale)) throw cannot("transformed group");
  const width = Math.floor(box.width * scale);
  return { width, height: Math.round((width * box.height) / box.width) };
}

/** Read one source and return what is needed to build it. Throws SourceError on a bad source. */
export async function loadSource(file, buffer) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const name = path.basename(file, path.extname(file));
  if (!SUPPORTED_EXT.includes(ext))
    throw new SourceError(file, `unsupported format ".${ext}". Use PNG, JPG, WebP or SVG.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name))
    throw new SourceError(file, "file name may only have letters, digits, - and _ (no spaces).");
  const base = { name, hash: hash8(buffer) };

  if (ext === "svg") {
    const svg = buffer.toString("utf8");
    const size = await wrappedRasterSize(svg, file);
    if (!size) {
      const box = svgBox(svg);
      if (!box) throw new SourceError(file, "SVG has no viewBox or width/height.");
      return { ...base, kind: "svg", width: box.width, height: box.height, svg };
    }
    // Render the SVG (keeps its crop, corners and opacity) at the real size of the picture inside.
    const at72 = await sharp(buffer, { density: 72, unlimited: true }).metadata();
    const density = Math.min(2400, Math.ceil((72 * size.width) / at72.width) + 1);
    const pixels = await sharp(buffer, { density, unlimited: true })
      .resize(size.width, size.height, { fit: "fill" })
      .png()
      .toBuffer();
    return { ...base, kind: "raster", ...size, pixels };
  }

  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw new SourceError(file, `cannot be read as an image. Export it again as PNG or JPG.`);
  }
  const turned = (meta.orientation ?? 1) >= 5;
  return {
    ...base,
    kind: "raster",
    width: turned ? meta.height : meta.width,
    height: turned ? meta.width : meta.height,
    pixels: buffer,
  };
}

/** Write every file of one version of one image. Returns its manifest entry. */
export async function buildVersion(file, buffer, outDir, config = {}) {
  const src = await loadSource(file, buffer);
  const dir = path.join(outDir, src.name);
  await mkdir(dir, { recursive: true });

  if (src.kind === "svg") {
    const { data } = optimize(src.svg, { multipass: true });
    await writeFile(path.join(dir, `${src.hash}.svg`), data);
    return { name: src.name, entry: { hash: src.hash, width: src.width, height: src.height, widths: [], formats: ["svg"] } };
  }

  const wanted = config.widths ?? DEFAULT_WIDTHS;
  const smallest = Math.min(...wanted);
  if (src.width < smallest && !config.allowSmallSource)
    throw new SourceError(file, `image is too small: ${src.width} px wide, and it needs at least ${smallest} px. Export a larger version.`);
  const widths = ladder(src.width, wanted);
  await mkdir(path.join(dir, src.hash), { recursive: true });
  for (const width of widths) {
    for (const format of FORMATS) {
      const info = await sharp(src.pixels)
        .rotate() // apply the camera orientation, if any
        .resize({ width, withoutEnlargement: true })
        .toFormat(format, { quality: QUALITY[format] })
        .toFile(path.join(dir, src.hash, `${width}.${format}`));
      if (info.width > src.width || info.width !== width)
        throw new Error(`${file}: built ${info.width} px for ${width}.${format}; source is ${src.width} px`);
    }
  }
  return { name: src.name, entry: { hash: src.hash, width: src.width, height: src.height, widths, formats: [...FORMATS] } };
}

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/**
 * The last committed version of image `name` that differs from `current` (any extension).
 * Returns { file, buffer } or null. Needs full git history.
 */
export function previousVersion(srcDir, name, current) {
  const commits = git(srcDir, "log", "--format=%H", "--", ".").toString().split("\n").filter(Boolean);
  for (const commit of commits) {
    const files = git(srcDir, "ls-tree", "--name-only", commit, "./").toString().split("\n");
    const file = files.find((f) => path.basename(f, path.extname(f)) === name);
    if (!file) continue;
    const buffer = git(srcDir, "show", `${commit}:./${file}`);
    if (!buffer.equals(current)) return { file, buffer };
  }
  return null;
}

function gitState(srcDir) {
  try {
    return git(srcDir, "rev-parse", "--is-shallow-repository").toString().trim() === "true" ? "shallow" : "full";
  } catch {
    return "none";
  }
}

/**
 * Build everything in srcDir into outDir. Returns { manifest, previous, errors }.
 * Source problems are collected in `errors` (SourceError) so one run reports all of them.
 */
export async function build({ srcDir, outDir, configPath, log = () => {} }) {
  let config = {};
  if (configPath) {
    try {
      config = JSON.parse(await readFile(configPath, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw new SourceError(configPath, `is not valid JSON (${e.message}).`);
    }
  }
  const history = gitState(srcDir);
  if (history === "shallow")
    throw new Error("git history is shallow, so previous versions cannot be built. Check out with fetch-depth: 0.");

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const files = (await readdir(srcDir, { withFileTypes: true }))
    .filter((d) => d.isFile() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
  const images = {};
  const previous = {};
  const errors = [];
  const seen = new Map();
  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    if (seen.has(name)) {
      errors.push(new SourceError(file, `there are two files for "${name}" (${seen.get(name)} and ${file}). Keep one.`));
      continue;
    }
    seen.set(name, file);
    try {
      const buffer = await readFile(path.join(srcDir, file));
      const { entry } = await buildVersion(file, buffer, outDir, config[name]);
      images[name] = entry;
      log(`built ${name} ${entry.hash} ${entry.width}x${entry.height} -> ${entry.widths.join(", ") || "svg"}`);
      if (history === "full") {
        const old = previousVersion(srcDir, name, buffer);
        if (old) {
          try {
            const built = await buildVersion(old.file, old.buffer, outDir, config[name]);
            previous[name] = built.entry.hash;
            log(`kept  ${name} ${built.entry.hash} (previous version)`);
          } catch (e) {
            log(`note: previous version of ${name} not built: ${e.message}`);
          }
        }
      }
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      errors.push(e);
    }
  }
  for (const name of Object.keys(config))
    if (!seen.has(name)) log(`note: images.config.json has settings for "${name}" but there is no such image`);

  const manifest = { version: 1, images };
  if (errors.length === 0) await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, previous, errors };
}
