// Content script — ONLY extracts article text. No player, no DOM injection.
// All UI lives in the extension popup.

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

  const paragraphs = article.textContent
    .split(/\n{2,}/)
    .map((p: string) => p.trim())
    .filter((p: string) => p.length > 10);

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
      sendResponse(extractArticle());
      return true;
    }
    return false;
  }
);
