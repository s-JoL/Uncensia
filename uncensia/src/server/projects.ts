import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Project } from "@shared/projects.ts";
import type { Store } from "./store/store.ts";

export const projectInput = z.object({title:z.string().trim().min(1).max(120), instructions:z.string().max(32000).default("")}).strict();
export const projectUpdate = projectInput.extend({revision:z.number().int().positive()});
const columns = "id,title,instructions,revision,created_at AS createdAt,updated_at AS updatedAt";
export const getProject = (store: Store, id: string) => store.db.get<Project>(`SELECT ${columns} FROM projects WHERE id=?`,id);
export const listProjects = (store: Store) => store.db.all<Project>(`SELECT ${columns} FROM projects ORDER BY updated_at DESC,id`);
export function createProject(store: Store, input: z.infer<typeof projectInput>) {
  const id = `project_${randomUUID()}`, now = Date.now();
  store.db.run("INSERT INTO projects(id,title,instructions,created_at,updated_at) VALUES(?,?,?,?,?)",id,input.title,input.instructions,now,now);
  return getProject(store,id)!;
}
export function updateProject(store: Store, id: string, input: z.infer<typeof projectUpdate>) {
  return store.db.transaction(() => {
    if (getProject(store,id)?.revision !== input.revision) return undefined;
    store.db.run("UPDATE projects SET title=?,instructions=?,revision=revision+1,updated_at=? WHERE id=?",input.title,input.instructions,Date.now(),id);
    return getProject(store,id)!;
  });
}
export function conversationProject(store: Store, conversationId: string) {
  const row = store.db.get<{project_id:string}>("SELECT project_id FROM conversation_projects WHERE conversation_id=?",conversationId);
  return row ? getProject(store,row.project_id) : undefined;
}

/** Undefined is an explicitly personal search; null is the unassigned library. */
export function projectFileFilter(projectId: string | null | undefined) {
  if (projectId === undefined) return {sql:"1", args:[] as string[]};
  return projectId === null
    ? {sql:"NOT EXISTS (SELECT 1 FROM project_files pf WHERE pf.file_id=f.id)", args:[] as string[]}
    : {sql:"EXISTS (SELECT 1 FROM project_files pf WHERE pf.file_id=f.id AND pf.project_id=?)", args:[projectId]};
}
export function projectFileIds(store: Store, projectId: string | null) {
  const filter = projectFileFilter(projectId);
  return store.db.all<{id:string}>(`SELECT f.id FROM files f WHERE ${filter.sql}`, ...filter.args).map(row=>row.id);
}

/** Every file ingress uses this, including duplicate uploads and generated media. */
export function linkConversationFile(store: Store, conversationId: string | null | undefined, fileId: string) {
  if (conversationId) store.db.run("INSERT OR IGNORE INTO project_files(project_id,file_id) SELECT project_id,? FROM conversation_projects WHERE conversation_id=?",fileId,conversationId);
}
