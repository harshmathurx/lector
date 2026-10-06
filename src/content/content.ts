// Content script — ONLY extracts article text. No player, no DOM injection.
// All UI lives in the extension popup.

console.log('[VB-CS] Content script loaded on', window.location.href);

import { Readability } from '@mozilla/readability';

interface ArticleContent {
  title: string;
  textContent: string;
  url: string;
  paragraphs: string[];
}

function extractArticle(): ArticleContent | null {
  const documentClone = document.cloneNode(true) as Document;
  const reader = new Readability(documentClone);
  const article = reader.parse();

  if (!article || !article.textContent) return null;

  // Split by double newlines first
  let paragraphs = article.textContent
    .split(/\n{2,}/)
    .map((p: string) => p.trim())
    .filter((p: string) => p.length > 10);

  // If we got very few paragraphs, split by single newlines too
  // (some sites like paulgraham.com have minimal markup)
  if (paragraphs.length <= 2) {
    paragraphs = article.textContent
      .split(/\n/)
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 30); // higher threshold for single-newline splits
  }

  // If still just one giant block, split by sentences into chunks
  if (paragraphs.length <= 1 && article.textContent.length > 500) {
    const text = article.textContent;
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks: string[] = [];
    let current = '';
    for (const s of sentences) {
      current += s;
      if (current.length > 300) { // ~2-3 sentences per chunk
        chunks.push(current.trim());
        current = '';
      }
    }
    if (current.trim()) chunks.push(current.trim());
    paragraphs = chunks;
  }

  console.log('[VB-CS] Paragraphs after splitting:', paragraphs.length);

  return {
    title: article.title || document.title,
    textContent: article.textContent,
    url: window.location.href,
    paragraphs,
  };
}

chrome.runtime.onMessage.addListener(
  (
    message: { type: string },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    if (message.type === 'EXTRACT_ARTICLE') {
      console.log('[VB-CS] Extract article requested');
      const article = extractArticle();
      console.log('[VB-CS] Extracted:', article ? `${article.paragraphs.length} paragraphs` : 'null');
      sendResponse(article);
      return true;
    }
    return false;
  }
);
