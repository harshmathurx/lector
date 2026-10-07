# Lector privacy policy

_Last updated: 7 October 2026_

Lector reads web pages aloud using a voice model that runs entirely on your own computer.

## What Lector does with your data

- **Page text** is read only on the tab where you ask Lector to listen. It is processed on your computer to produce speech and to highlight the sentence being read. It is never sent anywhere.
- **Generated audio** is kept in your browser's local storage (IndexedDB) for up to 48 hours, so that listening again is instant. You can clear it any time in Lector's Settings. It never leaves your computer.
- **Your settings** (voice, speed, favourites, toggles, voice quality) are stored locally with `chrome.storage`. They are not synced or sent anywhere.

## What Lector does not do

- No account, sign-in or registration.
- No analytics, tracking, telemetry, advertising or cookies.
- No sale or transfer of any data to anyone.
- No access to pages you haven't asked it to read.

## Network access

The only network request Lector makes is a one-time download of the open-source Kokoro voice model files from Hugging Face (`huggingface.co`). This request contains no information about you or the pages you read. After that download, Lector works offline. Hugging Face's own privacy policy applies to that download.

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Read the article on the current tab, only when you ask. |
| `offscreen` | Play audio in the background while you browse. |
| `storage` | Remember your settings and cached audio on your computer. |
| `contextMenus` | The right-click "Listen from here" and "Listen to selection" items. |
| `alarms` | Free memory when Lector has been idle for a while. |
| Host access to Hugging Face | Download the voice model once. |

## Contact

Questions or concerns: open an issue at https://github.com/harshmathurx/lector/issues or email harshmathurx@gmail.com.
