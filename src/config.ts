import 'dotenv/config';
import path from 'path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export type LlmProvider = 'together' | 'anthropic';

const provider = optional('LLM_PROVIDER', 'together').toLowerCase() as LlmProvider;
if (provider !== 'together' && provider !== 'anthropic') {
  throw new Error(`LLM_PROVIDER must be 'together' or 'anthropic', got '${provider}'`);
}

// Pick the right API key + models based on provider
let apiKey: string;
let classifierModel: string;
let judgeModel: string;

if (provider === 'together') {
  apiKey = required('TOGETHER_API_KEY');
  classifierModel = optional('TOGETHER_CLASSIFIER_MODEL', 'moonshotai/Kimi-K2-Instruct');
  judgeModel = optional('TOGETHER_JUDGE_MODEL', 'moonshotai/Kimi-K2-Instruct');
} else {
  apiKey = required('ANTHROPIC_API_KEY');
  classifierModel = optional('ANTHROPIC_CLASSIFIER_MODEL', 'claude-haiku-4-5-20251001');
  judgeModel = optional('ANTHROPIC_JUDGE_MODEL', 'claude-sonnet-4-6');
}

export const config = {
  llmProvider: provider,
  apiKey,
  classifierModel,
  judgeModel,
  dbPath: path.resolve(optional('DB_PATH', './data/lighthouse.db')),
  waAuthDir: path.resolve(optional('WA_AUTH_DIR', './src/whatsapp/auth')),
  logLevel: optional('LOG_LEVEL', 'info'),
  enableOutboundDms: optional('ENABLE_OUTBOUND_DMS', 'false') === 'true',
  webPort: parseInt(optional('WEB_PORT', '3000'), 10),
};
