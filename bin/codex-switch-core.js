const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const CODEX_DIR = path.join(os.homedir(), ".codex");
const PROFILES_DIR = path.join(os.homedir(), ".codex-profiles");
const PROFILE_FILES = ["auth.json", "config.toml", "AGENTS.md", "models_cache.json"];
const PROFILE_DIRS = ["rules", "pets"];
const VALID_NAME_RE = /^[A-Za-z0-9._@+-]+$/;

function usage() {
  return [
    "Usage:",
    "  codex-switch list",
    "  codex-switch current",
    "  codex-switch save <profile>",
    "  codex-switch new <profile>",
    "  codex-switch use <profile>",
    "  codex-switch rename <old> <new>",
    "  codex-switch delete <profile>",
    "  codex-switch path [profile]",
    "",
    "Options:",
    "  --force    Ignore the running-process safety check",
    "",
    "Notes:",
    "  - This is a manual profile switcher for Codex state under ~/.codex.",
    "  - It does not rotate accounts automatically.",
    "  - Close Codex before save/use/new unless you intentionally pass --force."
  ].join("\n");
}

function createError(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  return error;
}

function validateName(name) {
  if (!name) {
    throw createError("profile name is required");
  }
  if (!VALID_NAME_RE.test(name)) {
    throw createError(`invalid profile name: ${name}`);
  }
}

async function pathExists(targetPath) {
  try {
    await fsp.lstat(targetPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function ensureProfilesDir() {
  await fsp.mkdir(PROFILES_DIR, { recursive: true });
}

async function realpathIfExists(targetPath) {
  try {
    return await fsp.realpath(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function resolvedCodexDir() {
  const stat = await fsp.lstat(CODEX_DIR).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (!stat) {
    return CODEX_DIR;
  }

  if (stat.isSymbolicLink()) {
    return await fsp.realpath(CODEX_DIR);
  }

  if (process.platform === "win32") {
    const resolved = await realpathIfExists(CODEX_DIR);
    return resolved || CODEX_DIR;
  }

  return CODEX_DIR;
}

async function currentProfileName() {
  const stat = await fsp.lstat(CODEX_DIR).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (!stat) {
    return "missing";
  }

  const isManagedLink = stat.isSymbolicLink() || (process.platform === "win32" && stat.isDirectory());
  if (isManagedLink) {
    const resolved = await realpathIfExists(CODEX_DIR);
    const profilesRoot = await realpathIfExists(PROFILES_DIR);
    if (resolved && profilesRoot) {
      const relative = path.relative(profilesRoot, resolved);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative.split(path.sep)[0];
      }
    }

    if (stat.isSymbolicLink()) {
      return "external-link";
    }
  }

  return "unmanaged";
}

async function listCodexProcessesPortable() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-Process | Where-Object { $_.ProcessName -match '^(codex|Code|Code - Insiders|Codex)$' } | Select-Object -ExpandProperty Id"
      ]);
      return String(stdout || "").trim();
    }

    const { stdout } = await execFileAsync("ps", ["ax", "-o", "command="]);
    return String(stdout || "")
      .split("\n")
      .filter((line) => /(^|\/)(codex)(\s|$)|Codex\.app\/Contents\/MacOS|\/Applications\/Codex\.app/.test(line))
      .filter((line) => !/codex-switch/.test(line))
      .join("\n");
  } catch {
    return "";
  }
}

async function isCodexRunning() {
  if (process.platform !== "win32") {
    try {
      const { stdout } = await execFileAsync("lsof", ["+D", CODEX_DIR]);
      if (String(stdout || "").split("\n").slice(1).some((line) => line.trim())) {
        return true;
      }
    } catch {}
  }

  const matches = await listCodexProcessesPortable();
  return matches.trim().length > 0;
}

async function requireSafeState(force) {
  if (force) {
    return;
  }
  if (await isCodexRunning()) {
    throw createError("Codex appears to be running. Close Codex first, or rerun with --force.");
  }
}

async function copyIfExists(src, dst) {
  if (!await pathExists(src)) {
    return;
  }
  await fsp.cp(src, dst, {
    recursive: true,
    force: true,
    errorOnExist: false
  });
}

async function copyProfilePayload(src, dst) {
  await fsp.rm(dst, { recursive: true, force: true });
  await fsp.mkdir(dst, { recursive: true });

  for (const item of PROFILE_FILES) {
    await copyIfExists(path.join(src, item), path.join(dst, item));
  }

  for (const item of PROFILE_DIRS) {
    await copyIfExists(path.join(src, item), path.join(dst, item));
  }
}

async function saveProfile(name) {
  validateName(name);
  if (!await pathExists(CODEX_DIR)) {
    throw createError("~/.codex does not exist");
  }

  await ensureProfilesDir();
  const src = await resolvedCodexDir();
  const dest = path.join(PROFILES_DIR, name);
  const tmp = `${dest}.tmp.${process.pid}`;
  await fsp.rm(tmp, { recursive: true, force: true });
  await copyProfilePayload(src, tmp);
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.rename(tmp, dest);
  return `Saved current Codex credentials/config to: ${dest}`;
}

async function newProfile(name, force) {
  validateName(name);
  await requireSafeState(force);
  await ensureProfilesDir();

  const dest = path.join(PROFILES_DIR, name);
  if (await pathExists(dest)) {
    throw createError(`profile already exists: ${name}`);
  }

  await fsp.mkdir(dest, { recursive: true });
  const src = await resolvedCodexDir();
  for (const item of ["config.toml", "AGENTS.md"]) {
    await copyIfExists(path.join(src, item), path.join(dest, item));
  }
  for (const item of PROFILE_DIRS) {
    await copyIfExists(path.join(src, item), path.join(dest, item));
  }

  return [`Created fresh profile: ${dest}`, `Next: codex-switch use ${name}`].join("\n");
}

async function removeActiveCodexDir() {
  const stat = await fsp.lstat(CODEX_DIR).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!stat) {
    return;
  }
  if (stat.isSymbolicLink()) {
    await fsp.unlink(CODEX_DIR);
    return;
  }
  await fsp.rm(CODEX_DIR, { recursive: true, force: true });
}

async function linkProfile(dest) {
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fsp.symlink(dest, CODEX_DIR, linkType);
}

async function useProfile(name, force) {
  validateName(name);
  await requireSafeState(force);
  await ensureProfilesDir();

  const dest = path.join(PROFILES_DIR, name);
  if (!await pathExists(dest)) {
    throw createError(`profile does not exist: ${name}`);
  }

  const active = await currentProfileName();
  if (active === name) {
    return `Already using profile: ${name}`;
  }

  const stat = await fsp.lstat(CODEX_DIR).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (stat && !stat.isSymbolicLink()) {
    const resolved = await realpathIfExists(CODEX_DIR);
    const destResolved = await realpathIfExists(dest);
    if (resolved && destResolved && resolved === destResolved) {
      return `Already using profile: ${name}`;
    }

    const backupName = `pre-switch-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;
    const backupDest = path.join(PROFILES_DIR, backupName);
    await fsp.rename(CODEX_DIR, backupDest);
  } else {
    await removeActiveCodexDir();
  }

  await linkProfile(dest);
  return `Active Codex profile: ${name}`;
}

async function renameProfile(oldName, newName, force) {
  validateName(oldName);
  validateName(newName);
  await requireSafeState(force);
  await ensureProfilesDir();

  const src = path.join(PROFILES_DIR, oldName);
  const dest = path.join(PROFILES_DIR, newName);
  if (!await pathExists(src)) {
    throw createError(`profile does not exist: ${oldName}`);
  }
  if (await pathExists(dest)) {
    throw createError(`target profile already exists: ${newName}`);
  }

  const active = await currentProfileName();
  await fsp.rename(src, dest);
  if (active === oldName) {
    await removeActiveCodexDir();
    await linkProfile(dest);
  }

  return `Renamed profile: ${oldName} -> ${newName}`;
}

async function deleteProfile(name, force) {
  validateName(name);
  await requireSafeState(force);
  await ensureProfilesDir();

  const target = path.join(PROFILES_DIR, name);
  if (!await pathExists(target)) {
    throw createError(`profile does not exist: ${name}`);
  }

  const active = await currentProfileName();
  if (active === name) {
    throw createError(`cannot delete the active profile: ${name}`);
  }

  await fsp.rm(target, { recursive: true, force: true });
  return `Deleted profile: ${name}`;
}

async function listProfiles() {
  await ensureProfilesDir();
  const active = await currentProfileName();
  const entries = await fsp.readdir(PROFILES_DIR, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });

  const lines = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => `${name === active ? "*" : " "} ${name}`);

  return lines.length ? lines.join("\n") : `No saved Codex profiles in ${PROFILES_DIR}`;
}

async function printPath(name) {
  await ensureProfilesDir();
  if (!name) {
    return PROFILES_DIR;
  }
  validateName(name);
  return path.join(PROFILES_DIR, name);
}

async function run(argv = []) {
  const args = [...argv];
  let force = false;
  while (args[0] === "--force") {
    force = true;
    args.shift();
  }

  const command = args.shift() || "";
  switch (command) {
    case "list":
      return { stdout: await listProfiles(), stderr: "", exitCode: 0 };
    case "current":
      return { stdout: await currentProfileName(), stderr: "", exitCode: 0 };
    case "save":
      if (args.length !== 1) throw createError("usage: codex-switch save <profile>");
      return { stdout: await saveProfile(args[0]), stderr: "", exitCode: 0 };
    case "new":
      if (args.length !== 1) throw createError("usage: codex-switch new <profile>");
      return { stdout: await newProfile(args[0], force), stderr: "", exitCode: 0 };
    case "use":
      if (args.length !== 1) throw createError("usage: codex-switch use <profile>");
      return { stdout: await useProfile(args[0], force), stderr: "", exitCode: 0 };
    case "rename":
      if (args.length !== 2) throw createError("usage: codex-switch rename <old> <new>");
      return { stdout: await renameProfile(args[0], args[1], force), stderr: "", exitCode: 0 };
    case "delete":
      if (args.length !== 1) throw createError("usage: codex-switch delete <profile>");
      return { stdout: await deleteProfile(args[0], force), stderr: "", exitCode: 0 };
    case "path":
      if (args.length > 1) throw createError("usage: codex-switch path [profile]");
      return { stdout: await printPath(args[0]), stderr: "", exitCode: 0 };
    case "":
    case "-h":
    case "--help":
    case "help":
      return { stdout: usage(), stderr: "", exitCode: 0 };
    default:
      throw createError(`unknown command: ${command}`);
  }
}

module.exports = {
  CODEX_DIR,
  PROFILES_DIR,
  run
};
