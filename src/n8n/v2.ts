import { N8nClientBase } from './base.ts';

// Every n8n 2.x release, from 2.0. It uses only endpoints all of 2.x serves:
// POST /activate and /deactivate, and create-then-transfer for a project.
// (/publish, /unpublish and projectId on create arrived during 2.x: see v3.ts.)
// 2.x and 3.x share the draft/publish model, so V3 inherits updateWorkflow and
// listWorkflows from here.
export class N8nClientV2 extends N8nClientBase {
  async createWorkflow(body: unknown): Promise<{ id: string }> {
    const created = await this.req('POST', '/api/v1/workflows', body);
    // Early 2.x ignores projectId on create and puts the workflow in the API key's
    // personal project, so move it to the configured one.
    if (this.projectId && created?.id) await this.transferWorkflow(String(created.id), this.projectId);
    return created;
  }
  async activateWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/activate`); }
  async deactivateWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/deactivate`); }

  async updateWorkflow(id: string, body: unknown): Promise<any> {
    try {
      return await super.updateWorkflow(id, body);
    } catch (e: any) {
      // A PUT on a published workflow also re-publishes it. When n8n refuses that
      // publish for a missing permission it still keeps the new version as a draft,
      // so say so, but only when its 403 body names the permission. Any other 403
      // (e.g. no workflow:update: nothing was saved) and every other error pass
      // through as the same object.
      if (e?.status === 403 && /workflow:(activate|publish)/.test(e.message)) {
        const err: any = new Error(`n8n saved the new version of workflow ${id} as a DRAFT and refused to publish it because the API key lacks the workflow:activate / workflow:publish permission. Grant it and re-run \`n8c apply\` on the SAME saved plan — a fresh \`n8c plan\` compares against n8n's saved draft and will show no change — or set \`active: false\` in the workflow's file. (${e.message})`, { cause: e });
        err.status = e.status;
        throw err;
      }
      throw e;
    }
  }

  async listWorkflows(): Promise<any[]> {
    const rows = await super.listWorkflows();
    // 2.x: `active` is deprecated; activeVersionId is the truth. Normalize so
    // plan/pull never read the deprecated field on 2.x/3.x.
    return rows.map((w: any) => ('activeVersionId' in w ? { ...w, active: w.activeVersionId != null } : w));
  }
}
