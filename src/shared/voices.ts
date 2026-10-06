// Voice catalog. Kokoro's English phonemizer only handles English text, so
// non-English voices are kept behind an "Other languages" filter.

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
  // Non-English: these only sound right on text in their own language.
  { id: 'jf_alpha', name: 'Alpha', region: 'JP', gender: 'F', lang: 'ja' },
  { id: 'jf_gongitsune', name: 'Gongitsune', region: 'JP', gender: 'F', lang: 'ja' },
  { id: 'jf_nezumi', name: 'Nezumi', region: 'JP', gender: 'F', lang: 'ja' },
  { id: 'jf_tebukuro', name: 'Tebukuro', region: 'JP', gender: 'F', lang: 'ja' },
  { id: 'jm_kumo', name: 'Kumo', region: 'JP', gender: 'M', lang: 'ja' },
  { id: 'zf_xiaobei', name: 'Xiaobei', region: 'CN', gender: 'F', lang: 'zh' },
  { id: 'zf_xiaoni', name: 'Xiaoni', region: 'CN', gender: 'F', lang: 'zh' },
  { id: 'zf_xiaoxiao', name: 'Xiaoxiao', region: 'CN', gender: 'F', lang: 'zh' },
  { id: 'zf_xiaoyi', name: 'Xiaoyi', region: 'CN', gender: 'F', lang: 'zh' },
  { id: 'zm_yunjian', name: 'Yunjian', region: 'CN', gender: 'M', lang: 'zh' },
  { id: 'zm_yunxi', name: 'Yunxi', region: 'CN', gender: 'M', lang: 'zh' },
  { id: 'zm_yunxia', name: 'Yunxia', region: 'CN', gender: 'M', lang: 'zh' },
  { id: 'zm_yunyang', name: 'Yunyang', region: 'CN', gender: 'M', lang: 'zh' },
  { id: 'ef_dora', name: 'Dora', region: 'ES', gender: 'F', lang: 'es' },
  { id: 'em_alex', name: 'Alex', region: 'ES', gender: 'M', lang: 'es' },
  { id: 'em_santa', name: 'Santa', region: 'ES', gender: 'M', lang: 'es' },
  { id: 'ff_siwis', name: 'Siwis', region: 'FR', gender: 'F', lang: 'fr' },
  { id: 'hf_alpha', name: 'Alpha', region: 'IN', gender: 'F', lang: 'hi' },
  { id: 'hf_beta', name: 'Beta', region: 'IN', gender: 'F', lang: 'hi' },
  { id: 'hm_omega', name: 'Omega', region: 'IN', gender: 'M', lang: 'hi' },
  { id: 'hm_psi', name: 'Psi', region: 'IN', gender: 'M', lang: 'hi' },
  { id: 'if_sara', name: 'Sara', region: 'IT', gender: 'F', lang: 'it' },
  { id: 'im_nicola', name: 'Nicola', region: 'IT', gender: 'M', lang: 'it' },
  { id: 'pf_dora', name: 'Dora', region: 'BR', gender: 'F', lang: 'pt' },
  { id: 'pm_alex', name: 'Alex', region: 'BR', gender: 'M', lang: 'pt' },
  { id: 'pm_santa', name: 'Santa', region: 'BR', gender: 'M', lang: 'pt' },
];

export const DEFAULT_VOICE = 'af_heart';

export function findVoice(id: string): Voice | undefined {
  return VOICES.find((v) => v.id === id);
}

export function voiceName(id: string): string {
  return findVoice(id)?.name ?? id;
}
