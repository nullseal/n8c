// Extract system/user prompts from an n8n workflow's LLM nodes.
// - `@n8n/n8n-nodes-langchain.agent`: options.systemMessage (system) + text (user)
// - `@n8n/n8n-nodes-langchain.chainLlm`: messages.messageValues[] (by role) + text (user)
// Model nodes (lmChatOpenAi) carry no prompt and are skipped. Content is kept
// verbatim (n8n stores runtime expressions with a leading `=`).

export interface ExtractedPrompt {
  nodeName: string;
  nodeType: string;
  type: 'system' | 'user';
  content: string;
  index: number; // disambiguates multiple prompts of the same type on one node
}

function roleOf(messageValueType?: string): 'system' | 'user' {
  return /human/i.test(String(messageValueType ?? '')) ? 'user' : 'system';
}

export function extractWorkflowPrompts(workflow: any): ExtractedPrompt[] {
  const out: ExtractedPrompt[] = [];
  for (const node of workflow?.nodes ?? []) {
    if (node?.disabled) continue; // only active nodes
    const type: string = node?.type ?? '';
    const p = node?.parameters ?? {};
    const name: string = node?.name ?? '';

    if (type.endsWith('.agent')) {
      const sys = p?.options?.systemMessage;
      if (typeof sys === 'string' && sys.length) out.push({ nodeName: name, nodeType: type, type: 'system', content: sys, index: 0 });
      if (typeof p?.text === 'string' && p.text.length) out.push({ nodeName: name, nodeType: type, type: 'user', content: p.text, index: 0 });
    } else if (type.endsWith('.chainLlm')) {
      let i = 0;
      for (const mv of p?.messages?.messageValues ?? []) {
        if (typeof mv?.message === 'string' && mv.message.length) {
          out.push({ nodeName: name, nodeType: type, type: roleOf(mv.type), content: mv.message, index: i++ });
        }
      }
      if (typeof p?.text === 'string' && p.text.length) out.push({ nodeName: name, nodeType: type, type: 'user', content: p.text, index: i });
    }
  }
  return out;
}
