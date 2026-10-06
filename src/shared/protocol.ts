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
  /** Absolute URL of the article's lead image (og:image etc.), for Now Playing artwork. */
  image?: string;
  /** Site or author name for Now Playing ("og:site_name", author, else the hostname). */
  site?: string;
}

/** Voice quality preference (Settings). Takes effect the next time the engine loads. */
export type Quality = 'auto' | 'small' | 'smooth';
export const QUALITIES: Quality[] = ['auto', 'small', 'smooth'];

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
  /** WASM threads in use (null on WebGPU or before the engine loads). */
  threads: number | null;
  /** Language of the page being read (`<html lang>`), for the popup's own text. */
  lang?: string;
  /** Text of the segment currently being read. */
  currentText: string;
  /**
   * 0..1 through the SPOKEN part of the current segment (trailing pause
   * excluded). Kokoro gives no word timings, so UIs estimate the current word
   * by spreading this across the segment's characters.
   */
  segProgress: number;
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
  threads: null,
  currentText: '',
  segProgress: 0,
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
  | { type: 'VB_WARM' }
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
      quality?: Quality;
    }
  | { target: 'offscreen'; type: 'TTS_COMMAND'; command: Command }
  | { target: 'offscreen'; type: 'TTS_GET_STATE' }
  | { target: 'offscreen'; type: 'TTS_CLEAR_CACHE' }
  | { target: 'offscreen'; type: 'TTS_WARM'; quality?: Quality };

/** offscreen -> background */
export type OffscreenEvent =
  | { type: 'VB_EVENT'; kind: 'status'; status: Status; error?: string }
  /** Model download progress (whole percents), so the toolbar can say it with the popup closed. */
  | { type: 'VB_EVENT'; kind: 'progress'; fraction: number }
  | {
      type: 'VB_EVENT';
      kind: 'segment';
      paraIndex: number;
      start: number;
      end: number;
      /** Length of the spoken audio in ms (trailing pause excluded). */
      durationMs: number;
      /** Where playback starts within it, in ms (non-zero after resume). */
      offsetMs: number;
    }
  | { type: 'VB_EVENT'; kind: 'finished' };

/** background -> content script */
export type ContentRequest =
  | { type: 'VB_PING' }
  | { type: 'EXTRACT_ARTICLE'; mode: 'article' | 'selection' | 'fromSelection' }
  | {
      type: 'VB_HIGHLIGHT';
      paraIndex: number;
      start: number;
      end: number;
      durationMs: number;
      offsetMs: number;
    }
  /** Freeze the in-progress "ink" where it is (paused / buffering). */
  | { type: 'VB_HIGHLIGHT_PAUSE' }
  | { type: 'VB_HIGHLIGHT_CLEAR' };

export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
