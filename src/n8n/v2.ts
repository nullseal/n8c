import { N8nClientBase } from './base.ts';
import { stripManagedMarker } from '../layout.ts';

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
    return this.createThenMove('workflow', 'workflow:move', await this.sendWorkflow(body, (b) => this.req('POST', '/api/v1/workflows', b)),
      (id, project) => this.transferWorkflow(id, project), (id) => this.deleteWorkflow(id));
  }

  // n8n 2.0-2.15 have no workflow descriptions: their schema refuses the key in any
  // form (text, "" or null) with 400 "request/body must NOT have additional
  // properties" (live at 2.14.2). n8c sends one for every workflow built from a
  // nodes/ folder (its [n8c-managed] marker), so on that 400 the body is sent again
  // without it, and every later call on this client leaves it out up front. If the
  // retry fails as well, some other key was refused: that error propagates.
  private descriptionRefused = false;
  private async sendWorkflow(body: any, send: (body: unknown) => Promise<any>): Promise<any> {
    if (!body || typeof body !== 'object' || !('description' in body)) return send(body);
    const { description, ...rest } = body;
    if (!this.descriptionRefused) {
      try {
        return await send(body);
      } catch (e: any) {
        if (e?.status !== 400 || !/request\/body must NOT have additional properties/.test(e.message)) throw e;
      }
    }
    const result = await send(rest);
    this.descriptionRefused = true;
    // The marker alone is n8c's own text: dropping it needs no word.
    if (stripManagedMarker(description) !== '') {
      console.error(`  ⚠ workflow "${body.name}" was saved without its description: this n8n refuses workflow descriptions (n8n 2.16 added them). \`n8c plan\` keeps listing the description as a change until you remove it from the workflow's files or upgrade n8n.`);
    }
    return result;
  }
  // POST /credentials honors projectId only from 2.18; earlier 2.x silently creates
  // the credential in the API key's personal project. Create, then move, on every 2.x.
  async createCredential(body: unknown): Promise<{ id: string; updatedAt?: string }> {
    return this.createThenMove('credential', 'credential:move', await this.req('POST', '/api/v1/credentials', body),
      (id, project) => this.transferCredential(id, project), (id) => this.deleteCredential(id));
  }
  // Early 2.x rejects or ignores projectId in a create body, so a new item is created
  // first, then moved to the configured project. A failed move rolls the create back:
  // that keeps a retried `apply` from creating a second copy and never leaves an
  // orphan silently. Recording the mapping instead would make the retry update an item
  // stuck in the wrong project. n8n answers 400 when the item already belongs to the
  // target project (the key's own personal project): there is nothing to move, so
  // that counts as success. A credential's 400 says "…already owning it"; from n8n 2.3
  // a single workflow's says "…the same destination it already belongs to".
  private async createThenMove<T extends { id?: unknown }>(
    kind: string, scope: string, created: T,
    move: (id: string, projectId: string) => Promise<unknown>, remove: (id: string) => Promise<unknown>,
  ): Promise<T> {
    const project = this.projectId;
    if (!project || !created?.id) return created;
    const id = String(created.id);
    try {
      await move(id, project);
    } catch (moveError: any) {
      if (moveError?.status === 400 && /already owning it|same destination it already belongs to/.test(moveError.message)) return created;
      // 403 is a missing scope; anything else (e.g. 400 for a project that does not exist) is not.
      const hint = moveError?.status === 403
        ? `The API key most likely lacks the ${scope} scope.`
        : `Check that n8nProjectId ${project} exists and the API key can access it (moving needs the ${scope} scope).`;
      const what = `Created ${kind} ${id}, but moving it into n8nProjectId ${project} failed (${moveError?.message}). ${hint}`;
      let message: string;
      try {
        await remove(id);
        message = `${what} The new ${kind} was deleted again, so re-running \`n8c apply\` does not create a second copy.`;
      } catch (removeError: any) {
        message = `${what} Deleting it again also failed (${removeError?.message}): ${kind} ${id} was left in the API key's personal project and must be removed by hand.`;
      }
      const err: any = new Error(message, { cause: moveError });
      err.status = moveError?.status;
      throw err;
    }
    return created;
  }
  async activateWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/activate`); }
  async deactivateWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/deactivate`); }

  async updateWorkflow(id: string, body: unknown): Promise<any> {
    try {
      return await this.sendWorkflow(body, (b) => super.updateWorkflow(id, b));
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

  // POST /archive exists only from n8n 2.15. On 2.0-2.14 it answers 405 "POST method
  // not allowed" (the path matches GET /workflows/{id}/{versionId}) whether or not the
  // workflow exists; a 404 is treated the same way. A GET tells the cases apart.
  async archiveWorkflow(id: string): Promise<any> {
    try {
      return await super.archiveWorkflow(id);
    } catch (archiveError: any) {
      if (archiveError?.status !== 404 && archiveError?.status !== 405) throw archiveError;
      // GET /workflows/{id} exists in every 2.x. It 404s too: the workflow is really
      // gone, and a 404 reaches apply, which reads it as "already deleted" (the
      // archive's own 404 when it was one, else the GET's). Any other GET failure
      // propagates as itself, never as the archive error.
      try {
        await this.getWorkflow(id);
      } catch (getError: any) {
        throw getError?.status === 404 && archiveError.status === 404 ? archiveError : getError;
      }
      // The workflow exists, so this n8n has no archive endpoint. DELETE there is a
      // forced, permanent delete; there is nothing softer on those releases.
      let result;
      try {
        result = await this.deleteWorkflow(id);
      } catch (deleteError: any) {
        // The GET just proved the workflow exists, so a DELETE 404 must not reach apply,
        // which reads a 404 as "already deleted". Re-wrap it without that status.
        const err: any = new Error(`workflow ${id} could not be deleted after archive was unavailable: ${deleteError?.message}`, { cause: deleteError });
        err.status = deleteError?.status === 404 ? 502 : deleteError?.status;
        throw err;
      }
      console.error(`  ⚠ workflow ${id} was permanently deleted because this n8n has no archive endpoint (n8n 2.15+ archives instead).`);
      return result;
    }
  }

  async listWorkflows(opts: { descriptions?: boolean } = {}): Promise<any[]> {
    const rows = await super.listWorkflows(opts);
    // 2.x: `active` is deprecated; activeVersionId is the truth. Normalize so
    // plan/pull never read the deprecated field on 2.x/3.x.
    return rows.map((w: any) => ('activeVersionId' in w ? { ...w, active: w.activeVersionId != null } : w));
  }
}
