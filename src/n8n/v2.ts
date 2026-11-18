import { N8nClientBase } from './base.ts';

// For n8n 2.x. Its workflow calls use only endpoints every 2.x release serves:
// POST /activate and /deactivate, and create-then-transfer for a project, for
// workflows and credentials alike (/transfer needs the workflow:move /
// credential:move scope). (/publish, /unpublish and projectId on create arrived
// during 2.x: see v3.ts.) Credential updates and credential listing need later 2.x
// releases (2.4, 2.8): see the README. Archive (2.15) has a fallback below.
// 2.x and 3.x share the draft/publish model, so V3 inherits updateWorkflow and
// listWorkflows from here.
export class N8nClientV2 extends N8nClientBase {
  async createWorkflow(body: unknown): Promise<{ id: string }> {
    return this.createThenMove(await this.req('POST', '/api/v1/workflows', body), (id, project) => this.transferWorkflow(id, project));
  }
  // POST /credentials honors projectId only from 2.18; earlier 2.x silently creates
  // the credential in the API key's personal project. Create, then move, on every 2.x.
  async createCredential(body: unknown): Promise<{ id: string; updatedAt?: string }> {
    return this.createThenMove(await this.req('POST', '/api/v1/credentials', body), (id, project) => this.transferCredential(id, project));
  }
  // Early 2.x rejects or ignores projectId in a create body, so a new item is created
  // first, then moved to the configured project.
  private async createThenMove<T extends { id?: unknown }>(created: T, move: (id: string, projectId: string) => Promise<unknown>): Promise<T> {
    if (this.projectId && created?.id) await move(String(created.id), this.projectId);
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
        const err: any = new Error(`n8n saved the new version of workflow ${id} as a DRAFT and refused to publish it because the API key lacks the workflow:activate / workflow:publish permission. Grant it and re-run \`n8c apply\` on the SAME saved plan — a fresh \`n8c plan\` compares against n8n's saved draft and will show no change — or, to deploy without publishing, unpublish the workflow in n8n first AND set \`active: false\` in its file, then run \`n8c pull\` to record the version n8n already saved. (${e.message})`, { cause: e });
        err.status = e.status;
        throw err;
      }
      throw e;
    }
  }

  // POST /archive exists only from n8n 2.15; on 2.0-2.14 the route is missing, so it
  // answers 404 although the workflow exists. Tell the two 404s apart with a GET.
  async archiveWorkflow(id: string): Promise<any> {
    try {
      return await super.archiveWorkflow(id);
    } catch (archiveError: any) {
      if (archiveError?.status !== 404) throw archiveError;
      // GET /workflows/{id} exists in every 2.x. It 404s too: the workflow is really
      // gone (apply reads the original 404 as "already deleted"). Any other GET
      // failure propagates as itself, never as the archive 404.
      try {
        await this.req('GET', `/api/v1/workflows/${id}`);
      } catch (getError: any) {
        throw getError?.status === 404 ? archiveError : getError;
      }
      // The workflow exists, so this n8n has no archive endpoint. DELETE there is a
      // forced, permanent delete; there is nothing softer on those releases.
      const result = await this.deleteWorkflow(id);
      console.error(`  ⚠ workflow ${id} was permanently deleted because this n8n has no archive endpoint (n8n 2.15+ archives instead).`);
      return result;
    }
  }

  async listWorkflows(): Promise<any[]> {
    const rows = await super.listWorkflows();
    // 2.x: `active` is deprecated; activeVersionId is the truth. Normalize so
    // plan/pull never read the deprecated field on 2.x/3.x.
    return rows.map((w: any) => ('activeVersionId' in w ? { ...w, active: w.activeVersionId != null } : w));
  }
}
