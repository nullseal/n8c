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
      // A PUT on a published workflow re-publishes; without the workflow:activate
      // scope n8n answers 403 but STILL saves the new version as a draft.
      if (e?.status === 403) {
        throw new Error(`n8n saved the new version of workflow ${id} as a DRAFT but refused to publish it: the API key lacks the workflow:activate scope. Grant the scope (or unpublish the workflow) and apply again — n8n is now holding an unpublished draft. (${e.message})`);
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
