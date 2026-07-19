import { workflow } from './workflow.ts';
import { prompt } from './prompt.ts';
import { credential } from './credential.ts';
import { promptContent } from './prompt-content.ts';
import type { EntityDescriptor } from './types.ts';

export const entities: Record<string, EntityDescriptor> = { workflow, prompt, credential, 'prompt-content': promptContent };
export const entityByKind: Record<string, EntityDescriptor> = { workflows: workflow, prompts: prompt, credentials: credential, promptContents: promptContent };
