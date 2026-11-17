import { N8nClientBase } from './base.ts';

// n8n 2.x: "active" became draft/publish.
export class N8nClientV2 extends N8nClientBase {
  async createWorkflow(body: unknown): Promise<{ id: string }> {
    // 2.x accepts projectId directly on create (no transfer step).
    return this.req('POST', '/api/v1/workflows', this.projectId ? { ...(body as any), projectId: this.projectId } : body);
  }
  async activateWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/publish`); }
  async deactivateWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/unpublish`); }

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
