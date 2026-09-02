import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import path from "path";
import fs from "fs";

/**
 * Squirrel's bundled .NET tooling dies with "Fatal error: Unable to load file"
 * on any path containing a non-ASCII character, and this checkout lives under
 * a folder named with one. Electron Packager (plain Node) has no such problem,
 * so only the Squirrel inputs need staging onto a plain path: the icon here,
 * and the output directory via EVOLUTE_OUT_DIR in the build script.
 */
const STAGE_ROOT = process.env.EVOLUTE_BUILD_ROOT || "S:\\evolute-build";
function stageForSquirrel(relative: string): string {
  const source = path.resolve(__dirname, relative);
  // A fixed directory, not a mkdtemp one: Squirrel resolves iconUrl when the
  // installer runs, not when it is built, so the staged copy has to still be
  // there afterwards and at a path that does not change between builds.
  const dir = path.join(STAGE_ROOT, "brand");
  fs.mkdirSync(dir, { recursive: true });
  const staged = path.join(dir, path.basename(source));
  fs.copyFileSync(source, staged);
  return staged;
}

const squirrelIcon = stageForSquirrel("assets/icon.ico");

/**
 * The main process loads its windows with paths relative to `dist/main`, e.g.
 * `../../src/renderer/chat/index.html`, so the renderer HTML has to travel
 * with the build. Everything else under `src/` is TypeScript that has already
 * been compiled into `dist/`, and shipping it would just leak source.
 */
const keep = [
  /^\/package\.json$/,
  /^\/dist(\/|$)/,
  /^\/assets(\/|$)/,
  /^\/node_modules(\/|$)/,
  // Directory entries on the way to the renderer HTML.
  /^\/src$/,
  /^\/src\/renderer(\/[^/]+)?$/,
  /^\/src\/renderer\/[^/]+\/index\.html$/,
];

const drop = [
  // Build-time artefacts that bloat the installer without being read at runtime.
  /\.map$/,
  /\.d\.ts$/,
  /\.bak$/,
];

const config: ForgeConfig = {
  // Kept outside the project directory: with `tmpdir: false` the packager
  // builds straight into this folder, and fs-extra refuses to copy a directory
  // into a subdirectory of itself.
  // A previous build's app.asar can still be held open by the realtime virus
  // scanner, and packager unlinks the old output before writing the new one.
  // Pointing each run at a fresh directory means there is nothing to unlink.
  // Plain ASCII on purpose - see stageForSquirrel above. Overridden per run by
  // the build script so a scanner-locked previous output cannot block the next.
  outDir: process.env.EVOLUTE_OUT_DIR || "S:/evolute-build/out",
  packagerConfig: {
    // asar is off on purpose. The realtime virus scanner deep-scans the
    // packed archive the moment it is written and keeps a handle on it, which
    // makes the Squirrel maker die unlinking its copy of app.asar. Shipping
    // the files unpacked sidesteps that without weakening the scanner.
    asar: false,
    // The packager otherwise stages into a temp dir and renames it into place;
    // that rename hits the same scanner handles. Build in the output dir.
    tmpdir: false,
    icon: "assets/icon",
    // whisper-local resolves these against `process.resourcesPath` once the app
    // is packaged, so they have to sit beside app.asar rather than inside it.
    extraResource: ["bin", "models"],
    name: "Evolute",
    executableName: "evolute",
    appCopyright: "MIT licensed. Windows port of farzaa/clicky.",
    win32metadata: {
      CompanyName: "tekram",
      FileDescription: "eVolutɘ - AI screen companion",
      ProductName: "eVolutɘ",
      OriginalFilename: "evolute.exe",
    },
    ignore: (filePath: string) => {
      // Packager asks about "" for the project root itself; never ignore it.
      if (!filePath) return false;
      if (drop.some((re) => re.test(filePath))) return true;
      return !keep.some((re) => re.test(filePath));
    },
  },
  // Squirrel only. The ZIP maker pulls in cross-zip, which still calls
  // fs.rmdir(path, { recursive: true }) - removed in modern Node, so it throws
  // ERR_INVALID_ARG_VALUE and takes the whole make down with it.
  makers: [
    new MakerSquirrel({
      name: "Evolute",
      authors: "tekram",
      description: "eVolutɘ - AI-powered screen companion for Windows.",
      setupExe: "Evolute-Setup.exe",
      setupIcon: squirrelIcon,
      // Without this Squirrel falls back to Electron's own icon URL, and the
      // shortcuts plus the Add/Remove Programs entry end up showing the
      // Electron atom rather than the brand mark. Points at the staged copy
      // for the same reason setupIcon does.
      iconUrl: `file:///${squirrelIcon.split("\\").join("/")}`,
      noMsi: true,
    }),
  ],
  // No plugins. auto-unpack-natives requires asar, which is disabled above, and
  // it would do nothing anyway: every runtime dependency here is pure JS.
  plugins: [],
};

export default config;
