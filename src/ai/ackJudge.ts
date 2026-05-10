import fs from 'fs';
import path from 'path';
import { chatComplete } from './client';
import { config } from '../config';
import { logger } from '../utils/logger';

const PROMPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'prompts', 'ackJudge.md'),
  'utf-8'
);

export interface AckJudgement {
  isAck: boolean;
  reasoning: string;
}

/**
 * Asks the judge model whether `replyText` is a meaningful ack of `originalText`.
 * Used to decide if an open loop should auto-transition from 'open' -> 'acked'.
 */
export async function judgeAck(params: {
  groupName: string;
  originalText: string;
  replyText: string;
}): Promise<AckJudgement> {
  const prompt = PROMPT_TEMPLATE
    .replace('{{GROUP_NAME}}', params.groupName)
    .replace('{{ORIGINAL_TEXT}}', params.originalText)
    .replace('{{REPLY_TEXT}}', params.replyText);

  try {
    const text = await chatComplete({
      model: config.judgeModel,
      prompt,
      maxTokens: 256,
      temperature: 0,
    });
    return parseJudgeOutput(text);
  } catch (err) {
    logger.error({ err }, 'ack judge call failed, defaulting to not-ack');
    // Conservative default: if judge errors, don't auto-ack
    return { isAck: false, reasoning: 'Judge call failed' };
  }
}

function parseJudgeOutput(raw: string): AckJudgement {
  let cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    logger.warn({ raw: raw.slice(0, 200) }, 'judge: no JSON found, defaulting to not-ack');
    return { isAck: false, reasoning: 'Could not parse judge response' };
  }
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return {
      isAck: obj.is_ack === true,
      reasoning: String(obj.reasoning ?? '').slice(0, 300),
    };
  } catch (err) {
    logger.warn({ err, raw: raw.slice(0, 200) }, 'judge: JSON parse failed');
    return { isAck: false, reasoning: 'Judge response was malformed' };
  }
}
