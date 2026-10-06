// Turns display text into text a TTS model reads well. Applied per segment,
// AFTER chunking, so highlight offsets always refer to the original text.

const EMOJI_RE = /[\p{Extended_Pictographic}‍️]/gu;

export function prepareForSpeech(input: string): string {
  let t = input;

  // Invisible characters and soft hyphens
  t = t.replace(/[­​-‏⁠﻿]/g, '');

  // Citation markers: [1], [12], [a], [citation needed], [edit]
  t = t.replace(/\[(?:\d{1,3}|[a-z]|citation needed|edit|note \d+)\]/gi, '');

  // URLs and emails read as noise; say "link"
  t = t.replace(/\b(?:https?:\/\/|www\.)[^\s)]+/gi, 'link');
  t = t.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, 'email address');

  // Emoji
  t = t.replace(EMOJI_RE, '');

  // Punctuation the model handles poorly
  t = t.replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'");
  t = t.replace(/\s*[—–]\s*/g, ', ');
  t = t.replace(/\s*\.{3,}\s*/g, '… ');
  t = t.replace(/&/g, ' and ');
  t = t.replace(/\s*\/\s*/g, ' / ');
  t = t.replace(/[*_#`~^|<>{}\\]/g, ' ');

  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();

  // Give list items and headings a terminal mark so prosody falls naturally.
  if (t && !/[.!?…:;,"')\]]$/.test(t)) t += '.';

  return t;
}
