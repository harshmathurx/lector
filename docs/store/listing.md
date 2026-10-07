# Chrome Web Store listing: copy-paste reference

Package: `release/lector-<version>.zip` (`bun run package`). Images: this folder.

## Store listing tab

**Name:** Lector

**Summary** (max 132 chars, from the manifest):
Listen to any English web page with natural voices that run on your own computer. No account, nothing leaves your browser.

**Category:** Accessibility (alternative: Productivity)
**Language:** English

**Description:**

Lector reads web articles aloud in a voice you'd actually want to listen to.

Open an article, click Lector, and listen. The voice runs on your own computer, so there is no account, no subscription, and nothing you read is ever sent anywhere.

What you get:
• Natural voices. 28 American and British English voices with instant previews. Pick a favourite and switch any time, even mid-article.
• Follow along. The sentence being read is highlighted on the page, word by word, so you never lose your place. Pause and keep reading yourself whenever you like.
• Start anywhere. Select text and choose "Listen from here", or press Alt+Shift+H to start from where you are.
• Full control. Play, pause, skip by paragraph, seek, and change speed from 0.75× to 2× without the chipmunk effect. Works with your keyboard's media keys and your computer's Now Playing controls.
• Private by design. The voice model downloads once and then works offline. No tracking, no analytics, no sign-in.
• Made for everyone. Works fully with a keyboard and screen readers, supports high-contrast mode and reduced motion, and follows your light or dark theme.
• Light on your computer. Lector picks the best setup for your machine, uses your graphics chip when it can, and frees memory when you stop listening.

Good for: long reads you never get to, listening while you cook or walk, resting your eyes, focusing with ADHD, dyslexia, or just preferring to listen.

Keyboard shortcuts (change them at chrome://extensions/shortcuts):
• Alt+Shift+R: start or pause
• Alt+Shift+H: listen from here
• Alt+Shift+. and Alt+Shift+,: next and previous paragraph

Notes:
• English only for now.
• The first listen downloads the voice model once (about 90–330 MB depending on your computer). After that, starting is instant.

Lector is free and open source: https://github.com/harshmathurx/lector

**Images**
- Icon 128×128: `static/icons/icon-light-128.png`
- Screenshots 1280×800 (in order): `1-listen.png`, `2-follow.png`, `3-voices.png`, `4-private.png`
- Small promo tile 440×280: `promo-small-440x280.png`
- Marquee 1400×560 (optional): `promo-marquee-1400x560.png`

**Links**
- Homepage: https://github.com/harshmathurx/lector
- Support: https://github.com/harshmathurx/lector/issues

## Privacy practices tab

**Single purpose:**
Lector reads the article on the current web page aloud using a text-to-speech voice that runs on the user's own computer, and highlights the sentence being read.

**Permission justifications:**
- activeTab: Lector reads the article only on the tab where the user clicks Lector, uses a shortcut, or uses the context menu. It does not access any other tab.
- scripting: Injects Lector's content script into the active tab, only when the user starts listening, to extract the article text and highlight the sentence being read.
- offscreen: Plays the generated speech in an offscreen document so audio keeps playing while the user browses; extension service workers cannot play audio.
- storage: Stores the user's settings (voice, speed, favourites, toggles) and the current listening session on the device.
- contextMenus: Adds "Listen from here", "Listen to selection" and "Listen to this page" to the right-click menu.
- alarms: Closes the audio engine after a few idle minutes so its memory is freed.
- Host permission (huggingface.co, hf.co): Downloads the open-source Kokoro voice model files once. No user data is sent.

**Are you using remote code?** No.
(The ONNX Runtime and all JavaScript/WebAssembly are bundled in the package. Only model weights, which are data and not executable code, are downloaded from Hugging Face.)

**Data usage:** tick nothing in the "collects" list. Lector does not collect or transmit any user data; page text is processed locally and never leaves the device.
Certify all three statements:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/harshmathurx/lector/blob/main/PRIVACY.md

## Distribution

- Trader status: Non-trader (free, personal, open-source project).
- Visibility: Unlisted first to test the store build, then Public.
- Regions: All regions.
