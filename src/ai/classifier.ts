import fs from 'fs';
import path from 'path';
import { chatComplete } from './client';
import { config } from '../config';
import { logger } from '../utils/logger';
import { prefilter } from './prefilter';
import type { ClassificationResult, MessageCategory, Severity } from '../types/domain';

const PROMPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'prompts', 'classifier.md'),
  'utf-8'
);

const VALID_CATEGORIES: MessageCategory[] = [
  'escalation', 'request', 'update_needed', 'fyi', 'resolution', 'noise', 'unknown',
];
const VALID_SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];

export async function classify(params: {
  text: string | null;
  hasMedia: boolean;
  groupName: string;
  groupType: string;
  senderName: string | null;
}): Promise<ClassificationResult> {
  // 1. Try pre-filter — free and instant
  const pre = prefilter(params.text, params.hasMedia);
  if (pre) {
    logger.debug({ pre }, 'classified by prefilter');
    return pre;
  }

  // 2. Call the configured LLM provider
  const prompt = PROMPT_TEMPLATE
    .replace('{{GROUP_NAME}}', params.groupName)
    .replace('{{GROUP_TYPE}}', params.groupType)
    .replace('{{SENDER_NAME}}', params.senderName ?? 'unknown')
    .replace('{{MESSAGE_TEXT}}', params.text ?? '');

  try {
    const text = await chatComplete({
      model: config.classifierModel,
      prompt,
      maxTokens: 300,
      temperature: 0,
    });
    return parseClassifierOutput(text);
  } catch (err) {
    logger.error({ err }, 'classifier call failed, marking unknown');
    return {
      category: 'unknown',
      severity: 'low',
      summary: 'Classifier failed',
      reasoning: 'AI call errored, defaulting to unknown',
    };
  }
}

function parseClassifierOutput(raw: string): ClassificationResult {
  // Be forgiving: strip code fences, find first { and last }
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object found in response: ${raw.slice(0, 200)}`);
  }
  const json = cleaned.slice(start, end + 1);
  const obj = JSON.parse(json);

  const category = VALID_CATEGORIES.includes(obj.category) ? obj.category : 'unknown';
  const severity = VALID_SEVERITIES.includes(obj.severity) ? obj.severity : 'low';

  return {
    category,
    severity,
    summary: String(obj.summary ?? '').slice(0, 200),
    reasoning: String(obj.reasoning ?? '').slice(0, 500),
  };
}
