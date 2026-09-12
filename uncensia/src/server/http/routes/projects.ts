import { Hono } from "hono";
import type { Services } from "../../services.ts";
import { createProject, getProject, listProjects, projectInput, projectUpdate, updateProject } from "../../projects.ts";
import { listResources } from "../../resources.ts";
import { readJson } from "../body.ts";
import { fail } from "../errors.ts";

export function projectRoutes({store}: Services) {
  const app = new Hono();
  app.get("/projects", c => c.json(listProjects(store)));
  app.post("/projects", async c => {
    const input = projectInput.safeParse(await readJson(c));
    return input.success ? c.json(createProject(store,input.data),201) : fail(c,400,"invalid_project",input.error.message);
  });
  app.use("/projects/:id/*", async (c,next) => {
    if (!getProject(store,c.req.param("id")!)) return fail(c,404,"not_found","Project not found");
    await next();
  });
  app.get("/projects/:id", c => {
    const project = getProject(store,c.req.param("id"));
    return project ? c.json(project) : fail(c,404,"not_found","Project not found");
  });
  app.patch("/projects/:id", async c => {
    const input = projectUpdate.safeParse(await readJson(c));
    if (!input.success) return fail(c,400,"invalid_project",input.error.message);
    if (!getProject(store,c.req.param("id"))) return fail(c,404,"not_found","Project not found");
    const project = updateProject(store,c.req.param("id"),input.data);
    return project ? c.json(project) : fail(c,409,"project_changed","Project changed; reload before saving");
  });
  app.get("/projects/:id/conversations", c => c.json(store.db.all<{conversation_id:string}>("SELECT p.conversation_id FROM conversation_projects p JOIN conversations c ON c.id=p.conversation_id WHERE p.project_id=? AND c.archived=0 ORDER BY c.updated_at DESC",c.req.param("id")).map(row=>store.getConversation(row.conversation_id)!)));
  app.get("/projects/:id/files", c => {
    try { return c.json(listResources(store,{projectId:c.req.param("id"),cursor:c.req.query("cursor"),query:c.req.query("q")})); }
    catch (error) { return fail(c,400,"invalid_cursor",String(error)); }
  });
  app.put("/projects/:id/files/:file", c => {
    if (!store.getFile(c.req.param("file"))) return fail(c,404,"not_found","File not found");
    store.db.run("INSERT OR IGNORE INTO project_files(project_id,file_id) VALUES(?,?)",c.req.param("id"),c.req.param("file"));
    return c.body(null,204);
  });
  app.delete("/projects/:id/files/:file", c => {
    store.db.run("DELETE FROM project_files WHERE project_id=? AND file_id=?",c.req.param("id"),c.req.param("file"));
    return c.body(null,204);
  });
  return app;
}
