export class N8nClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;
  private projectId?: string; // scope workflows/credentials to one n8n project

  constructor(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch, projectId?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.projectId = projectId || undefined;
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: { 'X-N8N-API-KEY': this.apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    } as any);
    if (!res.ok) throw new Error(`n8n ${method} ${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  }

  // GET every page: the n8n Public API paginates (default 100) via `nextCursor`.
  private async reqAll(path: string): Promise<any[]> {
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

  async listWorkflows(): Promise<any[]> {
    // scope to the configured project so pull/plan don't mix other projects.
    return this.reqAll(this.projectId ? `/api/v1/workflows?projectId=${encodeURIComponent(this.projectId)}` : '/api/v1/workflows');
  }
  async createWorkflow(body: unknown): Promise<{ id: string }> {
    const created = await this.req('POST', '/api/v1/workflows', body);
    // n8n creates in the key's personal project; move it to the target project.
    if (this.projectId && created?.id) await this.transferWorkflow(String(created.id), this.projectId);
    return created;
  }
  async transferWorkflow(id: string, destinationProjectId: string): Promise<any> { return this.req('PUT', `/api/v1/workflows/${id}/transfer`, { destinationProjectId }); }
  async updateWorkflow(id: string, body: unknown): Promise<any> { return this.req('PUT', `/api/v1/workflows/${id}`, body); }
  async deleteWorkflow(id: string): Promise<any> { return this.req('DELETE', `/api/v1/workflows/${id}`); }
  async activateWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/activate`); }
  async deactivateWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/deactivate`); }
  async archiveWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/archive`); }
  async unarchiveWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/unarchive`); }
  async createCredential(body: unknown): Promise<{ id: string; updatedAt?: string }> {
    // POST /credentials defaults to the personal project — target the configured one.
    return this.req('POST', '/api/v1/credentials', this.projectId ? { ...(body as any), projectId: this.projectId } : body);
  }
  async listCredentials(): Promise<any[]> { return this.reqAll('/api/v1/credentials'); }
  async getCredential(id: string): Promise<any> { return this.req('GET', `/api/v1/credentials/${id}`); }
  // PATCH updates in place (keeps the id). isPartialData:true merges — so omitting
  // `data` PRESERVES the existing secret instead of wiping it.
  async updateCredential(id: string, body: unknown): Promise<{ id: string; updatedAt?: string }> { return this.req('PATCH', `/api/v1/credentials/${id}`, body); }
  async deleteCredential(id: string): Promise<any> { return this.req('DELETE', `/api/v1/credentials/${id}`); }
}
