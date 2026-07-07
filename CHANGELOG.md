## [1.4.2](https://github.com/khaosdoctor/scriba/compare/v1.4.0...v1.4.2) (2026-07-07)


### Features

* live per-jot status message edited in place through processing ([cf3db48](https://github.com/khaosdoctor/scriba/commit/cf3db4846caa6c2bb9aa3acfe27608c6a63cccc5))

## [1.4.0](https://github.com/khaosdoctor/scriba/compare/v1.3.0...v1.4.0) (2026-07-07)


### Features

* nightly habit review prompt with per-habit flow ([e1b59ce](https://github.com/khaosdoctor/scriba/commit/e1b59ce25cd434f2fc83811b39fbc698e4d7f512))
* strip secrets in pino core via redact ([827017c](https://github.com/khaosdoctor/scriba/commit/827017c029ba0fa6f9036bbf3d5b231871333a3b))

## [1.3.0](https://github.com/khaosdoctor/scriba/compare/v1.2.0...v1.3.0) (2026-07-07)


### Features

* add Telegram admin commands and runtime transcriber switch ([6082dcc](https://github.com/khaosdoctor/scriba/commit/6082dcc065b8eb2ae51e7d271c922cc028231b9b))
* register the / command menu (start, rate) ([0d017cf](https://github.com/khaosdoctor/scriba/commit/0d017cf622387290cf564197b0e5180b2422b494))
* thorough rating-command logging; document logging + command-menu conventions ([9561ed8](https://github.com/khaosdoctor/scriba/commit/9561ed865817eea6bee30c1ab70eebd19be190c6))

## [1.2.0](https://github.com/khaosdoctor/scriba/compare/v1.1.0...v1.2.0) (2026-07-07)


### Features

* nightly day-rating prompt with write-once gate ([21ab165](https://github.com/khaosdoctor/scriba/commit/21ab1653872fcea7b8302f3305fc86fc8aaf7b2b))

## [1.1.0](https://github.com/khaosdoctor/scriba/compare/v1.0.1...v1.1.0) (2026-07-07)


### Features

* outcome reactions and audio-only transcription ([85150b7](https://github.com/khaosdoctor/scriba/commit/85150b7e3c9044e63331a540da5629d3517482f9))
* surface jot processing feedback in telegram ([217619a](https://github.com/khaosdoctor/scriba/commit/217619a159807e4033179ba5b2fd89f31bc7e6e3))

## [1.0.1](https://github.com/khaosdoctor/scriba/compare/v1.0.0...v1.0.1) (2026-07-07)


### Features

* log version and commit sha at boot ([7af64d9](https://github.com/khaosdoctor/scriba/commit/7af64d9a833c12bf4bb5611d11b9e2bc4f77aa5b))

## [1.0.0](https://github.com/khaosdoctor/scriba/compare/c72c83b428a09515a6c56f3fa0bb10658eeb05f2...v1.0.0) (2026-07-07)


### Features

* atomic claim, capped retry with graceful give-up, queued edits, note-create mutex ([befcd86](https://github.com/khaosdoctor/scriba/commit/befcd868e063052f430e354017c3d589b8d73329))
* bundle parakeet sidecar for local transcription via compose profile ([5139b4a](https://github.com/khaosdoctor/scriba/commit/5139b4af3fe970dbd23e35c05b2ea027445c5938))
* default transcription to local (parakeet) instead of remote (groq) ([f1fcdb3](https://github.com/khaosdoctor/scriba/commit/f1fcdb3429e8d79406e58e747f6788f69c3ab1dd))
* force-retry button, merge queued edits, robust json parse ([a96c5e7](https://github.com/khaosdoctor/scriba/commit/a96c5e78cddf32498470e8d49fa1c47ea98ec817))
* **links:** REST title-search fallback when no local vault index ([6ed5584](https://github.com/khaosdoctor/scriba/commit/6ed5584139b39823afb309923ef275ddbd674a75))
* **logging:** add pino structured logging across all components ([0d17f15](https://github.com/khaosdoctor/scriba/commit/0d17f15056d118c09ba38a6bb3536a675cdc5610))
* scaffold scriba telegram journaling bot ([c72c83b](https://github.com/khaosdoctor/scriba/commit/c72c83b428a09515a6c56f3fa0bb10658eeb05f2))
* selectable transcription backend (groq remote or parakeet local) ([1fbd7bb](https://github.com/khaosdoctor/scriba/commit/1fbd7bbfc00d3b43038293df32c6c4c872dc0aaf))


### Bug Fixes

* **enrich:** cut link-suggestion noise and fix journal line placement ([b49626c](https://github.com/khaosdoctor/scriba/commit/b49626cf1944d4ea23702547a390422f84ff4171))
* HOST_PATH ([03a177d](https://github.com/khaosdoctor/scriba/commit/03a177de52fc49111c9d9c7bd381d3703fbcf9fa))
* **links:** mount vault at /vault from SCRIBA_VAULT_HOST_PATH ([6242a44](https://github.com/khaosdoctor/scriba/commit/6242a44d13b9a20dc99e737f8b46707a9d8c1f5d))
* **logging:** synchronous pino writes so container logs are never lost ([135a96e](https://github.com/khaosdoctor/scriba/commit/135a96e6e41843308bcf9e7e488dae71ecaac082))
* **logging:** use pino-pretty stream API, not the transport worker thread ([f441309](https://github.com/khaosdoctor/scriba/commit/f441309c39e0dc21d90a58ba90b975a1586693d0))
* **obsidian:** target journal heading by full path; ack + surface errors in telegram ([7d9782e](https://github.com/khaosdoctor/scriba/commit/7d9782e0ac42a3ea6f83e88f061766c389ac3aa8))
* review quick-wins (edit anchor safety, honest link ack, sweep reentrancy, prompt fencing) ([468f263](https://github.com/khaosdoctor/scriba/commit/468f263dbede0ebcd82131428af974b7bfb113de))
* **transcribe:** normalize Telegram .oga to .ogg for Groq upload ([39bcb8e](https://github.com/khaosdoctor/scriba/commit/39bcb8e2bf408427190082e07cd042f5612f9b9a))


### Performance Improvements

* incremental link index (mtime-based, re-read only changed files) ([1db23e1](https://github.com/khaosdoctor/scriba/commit/1db23e1ff00e0ee52606d2603bf9e2c9d99ba8f5))
* watch vault with native recursive fs.watch, refresh index on change ([bdd7632](https://github.com/khaosdoctor/scriba/commit/bdd76322764f48c7ef6fc751c98f63d3f4e2a295))

