import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadSkills, parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import type { ManagedSkill } from "@shared/types.ts";
import { paths } from "../env.ts";

const preferencesFile = path.join(paths.data, "skill-preferences.json");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (file: string) => hash(path.resolve(file));
function preferences(): Record<string, boolean> {
  return fs.existsSync(preferencesFile) ? JSON.parse(fs.readFileSync(preferencesFile, "utf8")) : {};
}
function write(file: string, content: string) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}
function editable(file: string) {
  const relative = path.relative(fs.realpathSync(paths.skills), fs.realpathSync(file));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
export function enabledSkills<T extends { skills: Skill[] }>(base: T): T {
  const state = preferences();
  return { ...base, skills: base.skills.filter(skill => state[key(skill.filePath)] !== false) };
}
export function managedSkills(cwd: string) {
  const result = loadSkills({ cwd, agentDir: path.join(paths.data, "agent"), skillPaths: [paths.skills], includeDefaults: true });
  const state = preferences();
  return {
    items: result.skills.map((skill): ManagedSkill => {
      const content = fs.readFileSync(skill.filePath, "utf8");
      return { id: key(skill.filePath), name: skill.name, description: skill.description, filePath: skill.filePath,
        editable: editable(skill.filePath), enabled: state[key(skill.filePath)] !== false,
        manualOnly: skill.disableModelInvocation, content, revision: hash(content) };
    }), diagnostics: result.diagnostics.map(item => `${item.path}: ${item.message}`),
  };
}
function validate(content: string) {
  if (Buffer.byteLength(content) > 256_000) throw new Error("技能文件不能超过 256 KB");
  const { frontmatter: header } = parseFrontmatter<Record<string, unknown>>(content);
  if (typeof header?.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(header.name) || typeof header.description !== "string" || !header.description.trim()) throw new Error("名称使用小写英文、数字和短横线，并填写描述");
  return header.name as string;
}
export function createSkill(content: string) {
  const name = validate(content);
  const directory = path.join(paths.skills, name);
  fs.mkdirSync(directory); // Refuse existing folders, including symlinks.
  fs.writeFileSync(path.join(directory, "SKILL.md"), content, { flag: "wx" });
}
export function updateSkill(skill: ManagedSkill, body: { enabled?: boolean; content?: string; revision?: string }) {
  if (body.content !== undefined) {
    if (!skill.editable || !editable(skill.filePath)) throw new Error("外部技能请在原位置编辑");
    validate(body.content);
    if (hash(fs.readFileSync(skill.filePath, "utf8")) !== body.revision) throw Object.assign(new Error("技能已被其他操作修改，请重新打开后编辑"), { status: 409 });
    write(skill.filePath, body.content);
  }
  if (body.enabled !== undefined) {
    const state = preferences();
    state[skill.id] = body.enabled;
    write(preferencesFile, JSON.stringify(state, null, 2));
  }
}
