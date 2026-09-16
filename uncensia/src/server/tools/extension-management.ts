/**
 * Pi extensions and packages as things the settings screen can manage.
 *
 * Pi already knows how to install an npm/git package and how to discover
 * `agent/extensions/*.ts`; what Uncensia adds is the record of which packages
 * the person chose and which files they switched off, kept outside Pi's
 * settings file so the in-memory settings each run builds can be derived from
 * it. Everything here is read at run start, so a change applies to the next
 * run and never to one that is already going.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DefaultPackageManager, SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import type { AgentExtension, AgentPackage, AgentResources, AgentResourceStatus } from "@shared/types.ts";
import { paths } from "../env.ts";

const agentDir = path.join(paths.data, "agent");
const extensionsDir = path.join(agentDir, "extensions");
const trashDir = path.join(agentDir, "extensions-trash");
const preferencesFile = path.join(paths.data, "agent-resources.json");
const statusFile = path.join(agentDir, "resource-status.json");

interface DisabledExtension {
  file: string;
  /** The package the file came from, or null for a local extension. Pi filters the two differently. */
  package: string | null;
}

interface Preferences {
  packages: Array<{ source: string; enabled: boolean; addedAt: number }>;
  /** Extension files switched off; the file stays where it is. */
  disabledExtensions: DisabledExtension[];
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (file: string) => hash(path.resolve(file));

function preferences(): Preferences {
  const fallback: Preferences = { packages: [], disabledExtensions: [] };
  if (!fs.existsSync(preferencesFile)) return fallback;
  const parsed = JSON.parse(fs.readFileSync(preferencesFile, "utf8")) as Partial<Preferences>;
  return {
    packages: Array.isArray(parsed.packages) ? parsed.packages : [],
    disabledExtensions: Array.isArray(parsed.disabledExtensions)
      ? parsed.disabledExtensions.filter((item) => typeof item.file === "string")
      : [],
  };
}

const sameFile = (a: string, b: string) => path.resolve(a) === path.resolve(b);

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

const savePreferences = (next: Preferences) => write(preferencesFile, JSON.stringify(next, null, 2));

/**
 * The npm the server itself was started with. A packaged install rarely has
 * `npm` on PATH, and Pi shells out to whatever this names for npm packages.
 */
function npmCommand(): string[] | undefined {
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return fs.existsSync(cli) ? [process.execPath, cli] : undefined;
}

/**
 * Pi settings that make the loader see exactly the chosen resources. A
 * disabled package is left out entirely so its code is never imported; a
 * disabled file is force-excluded with Pi's own `-path` syntax, on the
 * top-level list for local files and on the package entry for package files.
 */
export function resourceSettings(options: { includeDisabledPackages?: boolean } = {}): { packages: PackageSource[]; extensions: string[]; npmCommand?: string[] } {
  const state = preferences();
  const npm = npmCommand();
  const excluded = (source: string | null) =>
    state.disabledExtensions.filter((item) => item.package === source).map((item) => `-${item.file}`);
  return {
    packages: state.packages.filter((item) => item.enabled || options.includeDisabledPackages).map((item) => {
      const extensions = excluded(item.source);
      return extensions.length ? { source: item.source, extensions } : item.source;
    }),
    extensions: excluded(null),
    ...(npm ? { npmCommand: npm } : {}),
  };
}

function packageManager(cwd: string, options: { includeDisabledPackages?: boolean } = {}) {
  const settings = SettingsManager.inMemory(resourceSettings(options));
  return new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
}

function editable(file: string) {
  if (!fs.existsSync(extensionsDir)) return false;
  const relative = path.relative(fs.realpathSync(extensionsDir), fs.realpathSync(file));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resourceStatus(): AgentResourceStatus | null {
  try {
    return JSON.parse(fs.readFileSync(statusFile, "utf8")) as AgentResourceStatus;
  } catch {
    return null;
  }
}

/** Called by the run host after Pi loaded extensions, so the settings screen can show what happened. */
export function recordResourceStatus(status: Omit<AgentResourceStatus, "at">) {
  write(statusFile, JSON.stringify({ at: Date.now(), ...status }, null, 2));
}

export async function agentResources(cwd: string): Promise<AgentResources> {
  const state = preferences();
  const diagnostics: string[] = [];
  const manager = packageManager(cwd, { includeDisabledPackages: true });
  // Listing must not reach the network: a package that is configured but not
  // on disk is shown as such, and installing is an explicit action.
  const resolved = await manager.resolve(async () => "skip");
  const packageEnabled = (source: string) => state.packages.find((item) => item.source === source)?.enabled ?? true;
  const extensions: AgentExtension[] = resolved.extensions.map((resource) => {
    let content = "";
    try {
      content = fs.readFileSync(resource.path, "utf8");
    } catch (error) {
      diagnostics.push(`${resource.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const local = resource.metadata.origin === "top-level";
    return {
      id: key(resource.path),
      name: path.basename(resource.path).replace(/\.(ts|js)$/, "") === "index"
        ? path.basename(path.dirname(resource.path))
        : path.basename(resource.path).replace(/\.(ts|js)$/, ""),
      filePath: resource.path,
      editable: local && editable(resource.path),
      enabled: resource.enabled && (local || packageEnabled(resource.metadata.source)),
      source: local ? "local" : resource.metadata.source,
      content,
      revision: hash(content),
    };
  });
  const count = (source: string, items: Array<{ metadata: { source: string; origin: string } }>) =>
    items.filter((item) => item.metadata.origin === "package" && item.metadata.source === source).length;
  const packages: AgentPackage[] = state.packages.map((item) => ({
    source: item.source,
    enabled: item.enabled,
    installedPath: manager.getInstalledPath(item.source, "user") ?? null,
    resources: {
      extensions: count(item.source, resolved.extensions),
      skills: count(item.source, resolved.skills),
      prompts: count(item.source, resolved.prompts),
    },
    addedAt: item.addedAt,
  }));
  return { extensions, packages, diagnostics, status: resourceStatus() };
}

/** One package operation at a time: two installs sharing an npm prefix corrupt each other. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

const isLocalSource = (source: string) =>
  source.startsWith("/") || source.startsWith("./") || source.startsWith("../") || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("~");

function validatePackageSource(source: string) {
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > 500 || /\s/.test(trimmed)) throw new Error("请填写一个来源，例如 npm:包名、git:github.com/用户/仓库 或本机路径");
  if (isLocalSource(trimmed) && !fs.existsSync(path.resolve(trimmed.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? "")))) {
    throw new Error("本机路径不存在");
  }
  return trimmed;
}

export function installPackage(cwd: string, source: string) {
  const trimmed = validatePackageSource(source);
  return serial(async () => {
    const state = preferences();
    if (state.packages.some((item) => item.source === trimmed)) throw new Error("这个包已经添加过了");
    const log: string[] = [];
    const manager = packageManager(cwd);
    manager.setProgressCallback((event) => {
      if (event.message) log.push(event.message);
    });
    try {
      await manager.install(trimmed);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}${log.length ? `\n${log.join("\n")}` : ""}`);
    }
    state.packages.push({ source: trimmed, enabled: true, addedAt: Date.now() });
    savePreferences(state);
    return log;
  });
}

export function removePackage(cwd: string, source: string) {
  return serial(async () => {
    const state = preferences();
    if (!state.packages.some((item) => item.source === source)) throw Object.assign(new Error("没有这个包"), { status: 404 });
    const manager = packageManager(cwd);
    // Local folders are the person's own files; only downloaded copies are deleted.
    if (!isLocalSource(source)) await manager.remove(source);
    state.packages = state.packages.filter((item) => item.source !== source);
    savePreferences(state);
  });
}

export function updatePackage(cwd: string, source: string) {
  return serial(async () => {
    const state = preferences();
    if (!state.packages.some((item) => item.source === source)) throw Object.assign(new Error("没有这个包"), { status: 404 });
    const log: string[] = [];
    const manager = packageManager(cwd);
    manager.setProgressCallback((event) => {
      if (event.message) log.push(event.message);
    });
    await manager.update(source);
    return log;
  });
}

export function setPackageEnabled(source: string, enabled: boolean) {
  const state = preferences();
  const item = state.packages.find((entry) => entry.source === source);
  if (!item) throw Object.assign(new Error("没有这个包"), { status: 404 });
  item.enabled = enabled;
  savePreferences(state);
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateExtension(content: string) {
  if (Buffer.byteLength(content) > 512_000) throw new Error("扩展文件不能超过 512 KB");
  if (!/export\s+default\b/.test(content)) throw new Error("扩展需要默认导出一个函数：export default function (pi) { … }");
}

export function createExtension(name: string, content: string) {
  if (!NAME.test(name)) throw new Error("名称使用小写英文、数字和短横线");
  validateExtension(content);
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.writeFileSync(path.join(extensionsDir, `${name}.ts`), content, { flag: "wx" });
}

export function updateExtension(extension: AgentExtension, body: { enabled?: boolean; content?: string; revision?: string }) {
  if (body.content !== undefined) {
    if (!extension.editable || !editable(extension.filePath)) throw new Error("包内扩展请在包的来源处修改");
    validateExtension(body.content);
    if (hash(fs.readFileSync(extension.filePath, "utf8")) !== body.revision) {
      throw Object.assign(new Error("扩展已被其他操作修改，请重新打开后编辑"), { status: 409 });
    }
    write(extension.filePath, body.content);
  }
  if (body.enabled !== undefined) {
    const state = preferences();
    const file = path.resolve(extension.filePath);
    state.disabledExtensions = state.disabledExtensions.filter((item) => !sameFile(item.file, file));
    if (!body.enabled) state.disabledExtensions.push({ file, package: extension.source === "local" ? null : extension.source });
    savePreferences(state);
  }
}

/** Moves the file aside rather than deleting it: a switched-off extension is easy to bring back, a deleted one is not. */
export function deleteExtension(extension: AgentExtension) {
  if (!extension.editable || !editable(extension.filePath)) throw new Error("包内扩展请在包的来源处删除");
  fs.mkdirSync(trashDir, { recursive: true });
  fs.renameSync(extension.filePath, path.join(trashDir, `${Date.now()}-${path.basename(extension.filePath)}`));
  const state = preferences();
  state.disabledExtensions = state.disabledExtensions.filter((item) => !sameFile(item.file, extension.filePath));
  savePreferences(state);
}
