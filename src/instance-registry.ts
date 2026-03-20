import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface WorkspaceFolderInfo {
  name: string;
  fsPath: string;
}

export interface InstanceEntry {
  port: number;
  pid: number;
  workspaceFolders: WorkspaceFolderInfo[];
  startedAt: string;
}

const REGISTRY_DIR = path.join(os.homedir(), ".ide-code-debug");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "instances.json");
let registryDirCreated = false;

function isProcessAlive(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      // On Windows, process.kill(pid, 0) doesn't reliably check liveness.
      // Use tasklist to query by PID instead.
      const result = child_process.execSync(
        `tasklist /FI "PID eq ${pid}" /NH`,
        { encoding: "utf-8", timeout: 2000 }
      );
      return result.includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRegistry(): InstanceEntry[] {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeRegistry(entries: InstanceEntry[]): void {
  if (!registryDirCreated) {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    registryDirCreated = true;
  }
  const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  try {
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch {
    // On Windows, renameSync fails if target exists. Remove then rename.
    try { fs.unlinkSync(REGISTRY_FILE); } catch { /* noop */ }
    fs.renameSync(tmp, REGISTRY_FILE);
  }
}

export function registerInstance(
  port: number,
  workspaceFolders: WorkspaceFolderInfo[]
): void {
  // Remove stale entries (dead PIDs) and any previous entry for this port/pid
  const entries = readRegistry().filter(
    (e) => e.port !== port && e.pid !== process.pid && isProcessAlive(e.pid)
  );
  entries.push({
    port,
    pid: process.pid,
    workspaceFolders,
    startedAt: new Date().toISOString(),
  });
  writeRegistry(entries);
}

export function unregisterInstance(port: number): void {
  try {
    const entries = readRegistry().filter((e) => e.port !== port);
    writeRegistry(entries);
  } catch {
    // Best-effort cleanup
  }
}

export function getSiblingInstances(myPort: number): InstanceEntry[] {
  return readRegistry().filter(
    (e) => e.port !== myPort && isProcessAlive(e.pid)
  );
}
