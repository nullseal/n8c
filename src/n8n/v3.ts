import { N8nClientV2 } from './v2.ts';

// n8n 3.x. These endpoints exist from n8n 2.33 and in 3.x: POST /publish and
// /unpublish (2.33 deprecated /activate and /deactivate), and projectId in the
// create body (no transfer round-trip). Everything else is inherited from V2.
export class N8nClientV3 extends N8nClientV2 {
  async createWorkflow(body: unknown): Promise<{ id: string }> {
    return this.req('POST', '/api/v1/workflows', this.projectId ? { ...(body as any), projectId: this.projectId } : body);
  }
  async activateWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/publish`); }
  async deactivateWorkflow(id: string): Promise<any> { return this.req('POST', `/api/v1/workflows/${id}/unpublish`); }
}
