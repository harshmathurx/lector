// Types and message contracts shared by popup, background, content and offscreen.

export type ParagraphKind = 'text' | 'heading' | 'quote' | 'list';

export interface ArticleParagraph {
  text: string;
  kind: ParagraphKind;
}

export interface Article {
  title: string;
  lang: string;
  url: string;
  paragraphs: ArticleParagraph[];
  /** Paragraph to begin reading from (read-from-here). */
  startParagraph: number;
}

export type Status =
  | 'idle'
  | 'starting'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'error';

export interface PlayerState {
  status: Status;
  title: string;
  voice: string;
  speed: number;
  paraIndex: number;
  totalParas: number;
  /** 0..1, weighted by characters across the whole article. */
  progress: number;
  elapsed: number;
  /** Seconds left, or null when there is not enough data to estimate. */
  remaining: number | null;
  /** Model download progress, 0..1. */
  loadProgress: number;
  device: 'webgpu' | 'wasm' | null;
  /** Text of the segment currently being read. */
  currentText: string;
  error?: string;
  /** True when the offscreen document is gone but the session can be restarted. */
  recoverable?: boolean;
}

export const IDLE_STATE: PlayerState = {
  status: 'idle',
  title: '',
  voice: 'af_heart',
  speed: 1,
  paraIndex: 0,
  totalParas: 0,
  progress: 0,
  elapsed: 0,
  remaining: null,
  loadProgress: 0,
  device: null,
  currentText: '',
};

/** Persisted by the background so a dead offscreen document can be recovered. */
export interface StoredSession {
  article: Article;
  tabId: number;
  paraIndex: number;
}

export type Command =
  | { cmd: 'toggle' }
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  | { cmd: 'stop' }
  | { cmd: 'next' }
  | { cmd: 'prev' }
  | { cmd: 'seek'; progress: number }
  | { cmd: 'jump'; paragraph: number }
  | { cmd: 'voice'; voice: string }
  | { cmd: 'speed'; speed: number };

/** popup/commands -> background */
export type BackgroundRequest =
  | { type: 'VB_START'; mode?: 'article' | 'selection' | 'fromSelection' }
  | { type: 'VB_CMD'; command: Command }
  | { type: 'VB_GET_STATE' }
  | { type: 'VB_CLEAR_CACHE' }
  | { type: 'VB_JUMP'; paragraph: number };

/** anything -> offscreen (always tagged with target) */
export type OffscreenRequest =
  | { target: 'offscreen'; type: 'TTS_PING' }
  | {
      target: 'offscreen';
      type: 'TTS_START';
      article: Article;
      voice: string;
      speed: number;
    }
  | { target: 'offscreen'; type: 'TTS_COMMAND'; command: Command }
  | { target: 'offscreen'; type: 'TTS_GET_STATE' }
  | { target: 'offscreen'; type: 'TTS_CLEAR_CACHE' };

/** offscreen -> background */
export type OffscreenEvent =
  | { type: 'VB_EVENT'; kind: 'status'; status: Status; error?: string }
  | { type: 'VB_EVENT'; kind: 'segment'; paraIndex: number; start: number; end: number }
  | { type: 'VB_EVENT'; kind: 'finished' };

/** background -> content script */
export type ContentRequest =
  | { type: 'VB_PING' }
  | { type: 'EXTRACT_ARTICLE'; mode: 'article' | 'selection' | 'fromSelection' }
  | { type: 'VB_HIGHLIGHT'; paraIndex: number; start: number; end: number }
  | { type: 'VB_HIGHLIGHT_CLEAR' };

export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
