/**
 * Provider-agnostic LLM client.
 * Uniform `chatComplete()` regardless of Together (OpenAI-compatible) or Anthropic.
 * Retries transient errors (429, 5xx, network) with exponential backoff.
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../utils/logger';

interface ChatRequest {
  model: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

let openaiClient: OpenAI | null = null;
let anthropicClient: Anthropic | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.apiKey,
      baseURL: 'https://api.together.xyz/v1',
      maxRetries: 0,
    });
  }
  return openaiClient;
}

function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.apiKey, maxRetries: 0 });
  }
  return anthropicClient;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetryable(err: any): boolean {
  if (err?.status && RETRYABLE_STATUS.has(err.status)) return true;
  if (err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT') return true;
  if (err?.name === 'APIConnectionError') return true;
  return false;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function chatComplete(req: ChatRequest): Promise<string> {
  const maxTokens = req.maxTokens ?? 1024;
  const temperature = req.temperature ?? 0;
  const maxAttempts = 4;
  let lastErr: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (config.llmProvider === 'together') {
        const client = getOpenAI();
        const r = await client.chat.completions.create(
          {
            model: req.model,
            max_tokens: maxTokens,
            temperature,
            messages: [{ role: 'user', content: req.prompt }],
            // Disable Kimi's internal "thinking" — we want a direct answer
            chat_template_kwargs: { enable_thinking: false },
          } as any
        );
        const choice = r.choices[0];
        const message: any = choice?.message;
        const text = message?.content || message?.reasoning_content || message?.reasoning;
        if (!text) {
          logger.error(
            {
              finish_reason: choice?.finish_reason,
              message_keys: message ? Object.keys(message) : [],
              usage: r.usage,
            },
            'Together returned empty content'
          );
          throw new Error('Empty response from Together AI');
        }
        return text;
      }

      const client = getAnthropic();
      const r = await client.messages.create({
        model: req.model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: 'user', content: req.prompt }],
      });
      const block = r.content.find((b) => b.type === 'text');
      if (!block || block.type !== 'text') throw new Error('No text block in Anthropic response');
      return block.text;
    } catch (err: any) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
      logger.warn(
        { status: err?.status, attempt, delayMs: Math.round(delayMs) },
        'transient LLM error, retrying'
      );
      await sleep(delayMs);
    }
  }

  throw lastErr;
}
