import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { build, hash8, ladder, wrappedRasterSize, DEFAULT_WIDTHS } from "../scripts/pipeline.mjs";

const picture = (width, height, format = "png", seed = 1) =>
  sharp({ create: { width, height, channels: 3, background: { r: (seed * 70) % 256, g: 80, b: 160 } } })
    .toFormat(format)
    .toBuffer();

async function project(files, config) {
  const root = await mkdtemp(path.join(os.tmpdir(), "assets-test-"));
  const srcDir = path.join(root, "src-images");
  await mkdir(srcDir);
  for (const [name, data] of Object.entries(files)) await writeFile(path.join(srcDir, name), data);
  const configPath = path.join(root, "images.config.json");
  if (config) await writeFile(configPath, JSON.stringify(config));
  return { root, srcDir, outDir: path.join(root, "dist"), configPath };
}
const run = (p) => build({ srcDir: p.srcDir, outDir: p.outDir, configPath: p.configPath });
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });

test("hash8 is the first 8 hex characters of the SHA-256 of the source and is stable", () => {
  assert.equal(hash8(Buffer.from("abc")), "ba7816bf");
  assert.equal(hash8(Buffer.from("abc")), hash8(Buffer.from("abc")));
  assert.notEqual(hash8(Buffer.from("abc")), hash8(Buffer.from("abd")));
});

test("the same source gives the same paths on every build", async () => {
  const p = await project({ "a.png": await picture(700, 400) });
  const first = await run(p);
  const filesFirst = await readdir(p.outDir, { recursive: true });
  const second = await run(p);
  assert.deepEqual(second.manifest, first.manifest);
  assert.deepEqual(await readdir(p.outDir, { recursive: true }), filesFirst);
  assert.equal(first.manifest.images.a.hash, hash8(await readFile(path.join(p.srcDir, "a.png"))));
  await rm(p.root, { recursive: true });
});

test("ladder is cut off at the source width", () => {
  assert.deepEqual(ladder(4000), DEFAULT_WIDTHS);
  assert.deepEqual(ladder(1024), [320, 480, 640, 960, 1024]);
  assert.deepEqual(ladder(640), [320, 480, 640]);
  assert.deepEqual(ladder(610, [160, 320, 480]), [160, 320, 480]);
  assert.deepEqual(ladder(293), [293]);
});

test("no output is wider than its source, and each file has the width in its name", async () => {
  const p = await project({ "small.png": await picture(500, 300), "big.jpg": await picture(2500, 1000, "jpeg") });
  const { manifest, errors } = await run(p);
  assert.deepEqual(errors, []);
  assert.deepEqual(manifest.images.small.widths, [320, 480, 500]);
  assert.deepEqual(manifest.images.big.widths, [320, 480, 640, 960, 1280, 1920]);
  for (const [name, e] of Object.entries(manifest.images)) {
    const files = await readdir(path.join(p.outDir, name, e.hash));
    assert.equal(files.length, e.widths.length * 2);
    for (const f of files) {
      const meta = await sharp(path.join(p.outDir, name, e.hash, f)).metadata();
      assert.equal(meta.width, parseInt(f));
      assert.ok(meta.width <= e.width, `${name}/${f} is wider than the source`);
      assert.equal(meta.format === "heif" ? "avif" : meta.format, path.extname(f).slice(1));
    }
  }
  await rm(p.root, { recursive: true });
});

test("manifest shape", async () => {
  const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12" viewBox="0 0 24 12"><!-- note --><path d="M0 0h24v12H0z"/></svg>';
  const p = await project({ "wide.png": await picture(800, 200), "icon.svg": icon });
  const { manifest } = await run(p);
  const onDisk = JSON.parse(await readFile(path.join(p.outDir, "manifest.json"), "utf8"));
  assert.deepEqual(onDisk, manifest);
  assert.deepEqual(manifest, {
    version: 1,
    images: {
      icon: { hash: hash8(Buffer.from(icon)), width: 24, height: 12, widths: [], formats: ["svg"] },
      wide: { hash: manifest.images.wide.hash, width: 800, height: 200, widths: [320, 480, 640, 800], formats: ["avif", "webp"] },
    },
  });
  // vector SVG: optimised, not resized, at /<name>/<hash8>.svg
  const out = await readFile(path.join(p.outDir, "icon", `${manifest.images.icon.hash}.svg`), "utf8");
  assert.ok(!out.includes("note") && out.includes("viewBox"));
  await rm(p.root, { recursive: true });
});

test("per-image widths come from images.config.json", async () => {
  const p = await project({ "card.png": await picture(610, 962) }, { card: { widths: [160, 320, 480] } });
  const { manifest } = await run(p);
  assert.deepEqual(manifest.images.card.widths, [160, 320, 480]);
  await rm(p.root, { recursive: true });
});

test("a bad source fails with a clear message and no manifest", async () => {
  const p = await project({
    "tiny.png": await picture(200, 200),
    "photo.gif": await picture(600, 600, "gif"),
    "broken.png": Buffer.from("not an image"),
    "two.png": await picture(600, 600),
    "two.jpg": await picture(600, 600, "jpeg"),
    "my image.png": await picture(600, 600),
  });
  const { errors } = await run(p);
  const text = errors.map((e) => e.message).sort();
  assert.equal(text.length, 5);
  assert.match(text[0], /^broken\.png: cannot be read as an image/);
  assert.match(text[1], /^my image\.png: file name may only have/);
  assert.match(text[2], /^photo\.gif: unsupported format "\.gif"\. Use PNG, JPG, WebP or SVG\./);
  assert.match(text[3], /^tiny\.png: image is too small: 200 px wide, and it needs at least 320 px/);
  assert.match(text[4], /two files for "two"/);
  assert.ok(!existsSync(path.join(p.outDir, "manifest.json")));
  await rm(p.root, { recursive: true });
});

test("an SVG that wraps a picture is built at the real size of the picture, not enlarged", async () => {
  // Figma-style export: a 400 px picture shown 200 units wide in a 100-unit-wide view box (crop)
  const data = (await picture(400, 400)).toString("base64");
  const svg = `<svg width="1000" height="2000" viewBox="0 0 100 200" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<rect x="-50" width="200" height="200" fill="url(#p)"/><defs><pattern id="p" patternContentUnits="objectBoundingBox" width="1" height="1">
<use xlink:href="#i" transform="scale(0.0025)"/></pattern><image id="i" width="400" height="400" xlink:href="data:image/png;base64,${data}"/></defs></svg>`;
  assert.deepEqual(await wrappedRasterSize(svg), { width: 200, height: 400 });
  const p = await project({ "wrapped.svg": svg }, { wrapped: { widths: [100, 200, 400] } });
  const { manifest, errors } = await run(p);
  assert.deepEqual(errors, []);
  assert.deepEqual(manifest.images.wrapped, { hash: hash8(Buffer.from(svg)), width: 200, height: 400, widths: [100, 200], formats: ["avif", "webp"] });
  const meta = await sharp(path.join(p.outDir, "wrapped", manifest.images.wrapped.hash, "200.webp")).metadata();
  assert.deepEqual([meta.width, meta.height], [200, 400]);
  await rm(p.root, { recursive: true });
});

test("the previous committed version is kept for one more deploy", async () => {
  const p = await project({ "a.png": await picture(700, 400, "png", 1), "b.png": await picture(700, 400, "png", 9) });
  git(p.root, "init", "-q");
  const commit = async (seed, name = "a.png", format = "png") => {
    await writeFile(path.join(p.srcDir, name), await picture(700, 400, format, seed));
    git(p.root, "add", "-A");
    git(p.root, "commit", "-q", "-m", `v${seed}`);
  };
  const versions = async () => (await readdir(path.join(p.outDir, "a"))).sort();
  const urls = (hash) => [320, 480, 640, 700].flatMap((w) => ["avif", "webp"].map((f) => path.join(p.outDir, "a", hash, `${w}.${f}`)));

  await commit(1);
  const v1 = (await run(p)).manifest.images.a.hash;
  assert.deepEqual(await versions(), [v1]);

  await commit(2);
  const second = await run(p);
  const v2 = second.manifest.images.a.hash;
  assert.notEqual(v2, v1);
  assert.deepEqual(await versions(), [v1, v2].sort());
  assert.ok(urls(v1).every(existsSync), "old URLs still exist after the source changed");
  assert.deepEqual(second.previous, { a: v1 });
  assert.equal((await readdir(path.join(p.outDir, "b"))).length, 1, "an unchanged image has one version");

  // an unrelated commit does not drop the kept version
  await commit(5, "c.png");
  assert.deepEqual((await run(p)).previous, { a: v1 });

  // the next change drops v1; a new file type for the same name still counts as the same image
  await rm(path.join(p.srcDir, "a.png"));
  await commit(3, "a.jpg", "jpeg");
  const v3 = (await run(p)).manifest.images.a.hash;
  assert.deepEqual(await versions(), [v2, v3].sort());

  // a change that is not committed yet keeps the last committed version
  await writeFile(path.join(p.srcDir, "a.jpg"), await picture(700, 400, "jpeg", 4));
  const fourth = await run(p);
  assert.deepEqual(fourth.previous, { a: v3 });
  await rm(p.root, { recursive: true });
});

test("a shallow clone is refused, because previous versions cannot be found", async () => {
  const p = await project({ "a.png": await picture(700, 400) });
  git(p.root, "init", "-q");
  git(p.root, "add", "-A");
  git(p.root, "commit", "-q", "-m", "one");
  await writeFile(path.join(p.srcDir, "a.png"), await picture(700, 400, "png", 2));
  git(p.root, "commit", "-qam", "two");
  const clone = `${p.root}-shallow`;
  git(os.tmpdir(), "clone", "-q", "--depth", "1", `file://${p.root}`, clone);
  await assert.rejects(build({ srcDir: path.join(clone, "src-images"), outDir: path.join(clone, "dist") }), /fetch-depth: 0/);
  await rm(p.root, { recursive: true });
  await rm(clone, { recursive: true });
});
