// Voice catalog: the 28 voices kokoro-js can actually run. Its voice table and
// phonemizer (an English-only espeak-ng build) cover American and British
// English only; the model's other 26 voices (ja, zh, es, fr, hi, it, pt) are
// rejected with "Voice not found". Re-add them with a multilingual phonemizer.

export interface Voice {
  id: string;
  name: string;
  /** Short region tag shown in the UI, e.g. "US". */
  region: string;
  gender: 'F' | 'M';
  lang: string;
  /** Short human description of the voice's character. */
  vibe?: string;
}

export const VOICES: Voice[] = [
  { id: 'af_heart', name: 'Heart', region: 'US', gender: 'F', lang: 'en', vibe: 'Warm, natural. Best all-rounder' },
  { id: 'af_bella', name: 'Bella', region: 'US', gender: 'F', lang: 'en', vibe: 'Expressive and bright' },
  { id: 'af_nicole', name: 'Nicole', region: 'US', gender: 'F', lang: 'en', vibe: 'Soft, calm' },
  { id: 'af_sarah', name: 'Sarah', region: 'US', gender: 'F', lang: 'en' },
  { id: 'af_sky', name: 'Sky', region: 'US', gender: 'F', lang: 'en' },
  { id: 'af_nova', name: 'Nova', region: 'US', gender: 'F', lang: 'en' },
  { id: 'af_kore', name: 'Kore', region: 'US', gender: 'F', lang: 'en' },
  { id: 'af_aoede', name: 'Aoede', region: 'US', gender: 'F', lang: 'en' },
  { id: 'af_alloy', name: 'Alloy', region: 'US', gender: 'F', lang: 'en' },
  { id: 'af_jessica', name: 'Jessica', region: 'US', gender: 'F', lang: 'en' },
  { id: 'af_river', name: 'River', region: 'US', gender: 'F', lang: 'en' },
  { id: 'am_michael', name: 'Michael', region: 'US', gender: 'M', lang: 'en', vibe: 'Steady, clear narrator' },
  { id: 'am_fenrir', name: 'Fenrir', region: 'US', gender: 'M', lang: 'en', vibe: 'Deep and strong' },
  { id: 'am_puck', name: 'Puck', region: 'US', gender: 'M', lang: 'en' },
  { id: 'am_adam', name: 'Adam', region: 'US', gender: 'M', lang: 'en' },
  { id: 'am_echo', name: 'Echo', region: 'US', gender: 'M', lang: 'en' },
  { id: 'am_eric', name: 'Eric', region: 'US', gender: 'M', lang: 'en' },
  { id: 'am_liam', name: 'Liam', region: 'US', gender: 'M', lang: 'en' },
  { id: 'am_onyx', name: 'Onyx', region: 'US', gender: 'M', lang: 'en' },
  { id: 'am_santa', name: 'Santa', region: 'US', gender: 'M', lang: 'en' },
  { id: 'bf_emma', name: 'Emma', region: 'UK', gender: 'F', lang: 'en', vibe: 'Polished British' },
  { id: 'bf_isabella', name: 'Isabella', region: 'UK', gender: 'F', lang: 'en' },
  { id: 'bf_alice', name: 'Alice', region: 'UK', gender: 'F', lang: 'en' },
  { id: 'bf_lily', name: 'Lily', region: 'UK', gender: 'F', lang: 'en' },
  { id: 'bm_george', name: 'George', region: 'UK', gender: 'M', lang: 'en', vibe: 'Classic British narrator' },
  { id: 'bm_fable', name: 'Fable', region: 'UK', gender: 'M', lang: 'en' },
  { id: 'bm_daniel', name: 'Daniel', region: 'UK', gender: 'M', lang: 'en' },
  { id: 'bm_lewis', name: 'Lewis', region: 'UK', gender: 'M', lang: 'en' },
];

export const DEFAULT_VOICE = 'af_heart';

export function findVoice(id: string): Voice | undefined {
  return VOICES.find((v) => v.id === id);
}

export function voiceName(id: string): string {
  return findVoice(id)?.name ?? id;
}
