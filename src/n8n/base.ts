import { debugRequest, debugResponse } from '../debug.ts';

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
  abstract activateWorkflow(id: string): Promise<any>;
  abstract deactivateWorkflow(id: string): Promise<any>;

  // Concrete (subclasses override and call super): an abstract method cannot be
  // reached through `super`, which V2's normalizing override needs.
  async listWorkflows(): Promise<any[]> {
    // scope to the configured project so pull/plan don't mix other projects.
    return this.reqAll(this.projectId ? `/api/v1/workflows?projectId=${encodeURIComponent(this.projectId)}` : '/api/v1/workflows');
  }
  async updateWorkflow(id: string, body: unknown): Promise<any> { return this.req('PUT', `/api/v1/workflows/${id}`, body); }
  async deleteWorkflow(id: string): Promise<any> { return this.req('DELETE', `/api/v1/workflows/${id}`); }
  async archiveWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/archive`); }

  async createCredential(body: unknown): Promise<{ id: string; updatedAt?: string }> {
    // POST /credentials defaults to the personal project — target the configured one.
    return this.req('POST', '/api/v1/credentials', this.projectId ? { ...(body as any), projectId: this.projectId } : body);
  }
  async listCredentials(): Promise<any[]> { return this.reqAll('/api/v1/credentials'); }
  // The JSON Schema for a credential type's `data` fields — the only way to learn
  // the field names, since n8n never returns credential data itself.
  async getCredentialSchema(typeName: string): Promise<any> { return this.req('GET', `/api/v1/credentials/schema/${encodeURIComponent(typeName)}`); }
  // PATCH updates in place (keeps the id). isPartialData:true merges — so omitting
  // `data` PRESERVES the existing secret instead of wiping it.
  async updateCredential(id: string, body: unknown): Promise<{ id: string; updatedAt?: string }> { return this.req('PATCH', `/api/v1/credentials/${id}`, body); }
  async deleteCredential(id: string): Promise<any> { return this.req('DELETE', `/api/v1/credentials/${id}`); }
}
