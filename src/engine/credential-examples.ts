// Example `data` shapes for common n8n credential types: `pull` writes one as a
// commented hint, and `n8c create credential` scaffolds it as live code, renaming
// each MY_ placeholder after the credential. The keys are defined by the TYPE, not
// by n8c — n8n never returns credential data, so it can't be pulled and we can only
// suggest. A wrong key is rejected by n8n with a 400. Never name a variable n8c
// itself reads (MONGO_URI, N8N_*, …): a scaffold would send it to n8n as the secret.
export const CREDENTIAL_DATA_EXAMPLE: Record<string, string> = {
  httpHeaderAuth: "{ name: 'Authorization', value: process.env.MY_TOKEN }",
  httpQueryAuth: "{ name: 'api_key', value: process.env.MY_TOKEN }",
  httpBasicAuth: '{ user: process.env.MY_USER, password: process.env.MY_PASSWORD }',
  openAiApi: '{ apiKey: process.env.OPENAI_API_KEY }',
  // n8n reads connectionString only in this configuration; its default, 'values',
  // connects with host/user and ignores the string.
  mongoDb: "{ configurationType: 'connectionString', connectionString: process.env.MY_MONGO_URI }",
};
