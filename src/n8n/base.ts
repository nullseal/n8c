import { debugRequest, debugResponse } from '../debug.ts';

// How many GET /workflows/{id} listWorkflows({ descriptions: true }) runs at once.
const DESCRIPTION_FETCHES = 8;

// Version-independent plumbing shared by the n8n 2.x / 3.x API clients.
// Subclasses supply only the verbs whose behavior differs between versions.
export abstract class N8nClientBase {
  protected baseUrl: string;
  protected apiKey: string;
  protected fetchImpl: typeof fetch;
  protected projectId?: string; // scope workflows/credentials to one n8n project

  constructor(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch, projectId?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.projectId = projectId || undefined;
  }

  protected async req(method: string, path: string, body?: unknown): Promise<any> {
    debugRequest(method, path, body); // secrets are redacted in there, never printed
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: { 'X-N8N-API-KEY': this.apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    } as any);
    if (!res.ok) {
      const text = await res.text();
      debugResponse(res.status, text);
      const e: any = new Error(`n8n ${method} ${path} -> ${res.status} ${text}`);
      e.status = res.status;
      throw e;
    }
    debugResponse(res.status);
    // 204 No Content has no body, and .json() rejects an empty one (n8n answers a
    // workflow transfer this way).
    if (res.status === 204) return undefined;
    return res.json();
  }

  // GET every page: the n8n Public API paginates (default 100) via `nextCursor`.
  protected async reqAll(path: string): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const page = await this.req('GET', cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path);
      if (Array.isArray(page?.data)) out.push(...page.data);
      cursor = page?.nextCursor ?? undefined;
    } while (cursor);
    return out;
  }

  // The version-specific verbs. Everything else is shared.
  abstract createWorkflow(body: unknown): Promise<{ id: string }>;
  abstract createCredential(body: unknown): Promise<{ id: string; updatedAt?: string }>;
  abstract activateWorkflow(id: string): Promise<any>;
  abstract deactivateWorkflow(id: string): Promise<any>;

  // Concrete (subclasses override and call super): an abstract method cannot be
  // reached through `super`, which V2's normalizing override needs.
  //
  // n8n's workflow list never includes `description` (live at 2.14.2, 2.48.6 and
  // 3.3.0); GET /workflows/{id} does, as null when there is none. `descriptions`
  // completes every row that lacks the key from that GET, for pull and plan.
  // Callers that need only ids/updatedAt/active (the drift baseline) leave it off.
  async listWorkflows(opts: { descriptions?: boolean } = {}): Promise<any[]> {
    // scope to the configured project so pull/plan don't mix other projects.
    const rows = await this.reqAll(this.projectId ? `/api/v1/workflows?projectId=${encodeURIComponent(this.projectId)}` : '/api/v1/workflows');
    if (opts.descriptions) await this.fillDescriptions(rows);
    return rows;
  }
  async getWorkflow(id: string): Promise<any> { return this.req('GET', `/api/v1/workflows/${id}`); }

  // One GET per row, DESCRIPTION_FETCHES at a time. A 404 means the workflow was
  // deleted after the list was read: its row stays as listed. Any other error rejects.
  private async fillDescriptions(rows: any[]): Promise<void> {
    const todo = rows.filter((w) => !('description' in w));
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const w = todo[next++];
        try { w.description = (await this.getWorkflow(String(w.id))).description; }
        catch (e: any) { if (e?.status !== 404) throw e; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DESCRIPTION_FETCHES, todo.length) }, worker));
  }
  async updateWorkflow(id: string, body: unknown): Promise<any> { return this.req('PUT', `/api/v1/workflows/${id}`, body); }
  // Moves a workflow to another project. n8n answers 204 with no body.
  async transferWorkflow(id: string, destinationProjectId: string): Promise<any> { return this.req('PUT', `/api/v1/workflows/${id}/transfer`, { destinationProjectId }); }
  // Moves a credential to another project (n8n 2.0+, needs credential:move). 204, no body.
  async transferCredential(id: string, destinationProjectId: string): Promise<any> { return this.req('PUT', `/api/v1/credentials/${id}/transfer`, { destinationProjectId }); }
  async deleteWorkflow(id: string): Promise<any> { return this.req('DELETE', `/api/v1/workflows/${id}`); }
  async archiveWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/archive`); }

  async listCredentials(): Promise<any[]> { return this.reqAll('/api/v1/credentials'); }
  // The JSON Schema for a credential type's `data` fields — the only way to learn
  // the field names, since n8n never returns credential data itself.
  async getCredentialSchema(typeName: string): Promise<any> { return this.req('GET', `/api/v1/credentials/schema/${encodeURIComponent(typeName)}`); }
  // PATCH updates in place (keeps the id). isPartialData:true merges — so omitting
  // `data` PRESERVES the existing secret instead of wiping it.
  async updateCredential(id: string, body: unknown): Promise<{ id: string; updatedAt?: string }> { return this.req('PATCH', `/api/v1/credentials/${id}`, body); }
  async deleteCredential(id: string): Promise<any> { return this.req('DELETE', `/api/v1/credentials/${id}`); }
}
