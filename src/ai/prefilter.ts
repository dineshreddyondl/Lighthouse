import type { ClassificationResult } from '../types/domain';

/**
 * Fast, free pre-filter that catches obvious noise without an AI call.
 * Returns a ClassificationResult to skip Claude, or null to proceed.
 */
export function prefilter(text: string | null, hasMedia: boolean): ClassificationResult | null {
  // Media-only with no caption — let pipeline mark as unknown without burning tokens
  if (!text || text.trim().length === 0) {
    return {
      category: hasMedia ? 'unknown' : 'noise',
      severity: 'low',
      summary: hasMedia ? 'Media-only message' : 'Empty message',
      reasoning: 'Pre-filter: no text content',
    };
  }

  const trimmed = text.trim();

  // Very short messages that are almost certainly noise
  if (trimmed.length <= 3) {
    return {
      category: 'noise',
      severity: 'low',
      summary: 'Very short message',
      reasoning: 'Pre-filter: ≤3 chars',
    };
  }

  // Pure emoji / punctuation — no alphanumeric content
  if (!/[a-zA-Z0-9\u0900-\u097F]/.test(trimmed)) {
    return {
      category: 'noise',
      severity: 'low',
      summary: 'Emoji or punctuation only',
      reasoning: 'Pre-filter: no alphanumeric or Devanagari characters',
    };
  }

  // Common one-word noise (case-insensitive)
  const lowered = trimmed.toLowerCase();
  const noiseWords = new Set([
    'ok', 'okay', 'okk', 'okkk', 'k',
    'yes', 'yep', 'yeah', 'haan', 'haa',
    'no', 'nope', 'nahi',
    'thanks', 'thank you', 'ty', 'thx',
    'welcome', 'wlcm',
    'hi', 'hello', 'hey', 'namaste',
    'bye', 'tata',
    'lol', 'haha', 'lmao', 'rofl',
    'sure', 'fine', 'great', 'nice', 'cool',
  ]);
  if (noiseWords.has(lowered)) {
    return {
      category: 'noise',
      severity: 'low',
      summary: 'One-word filler',
      reasoning: 'Pre-filter: common filler word',
    };
  }

  return null; // Proceed to Claude
}
