## [1.48.1](https://github.com/khaosdoctor/scriba/compare/v1.48.0...v1.48.1) (2026-09-28)


### Bug Fixes

* **enrich:** stop raw JSON in the journal and keep jots from hanging ([#19](https://github.com/khaosdoctor/scriba/issues/19)) ([f08f827](https://github.com/khaosdoctor/scriba/commit/f08f827ee8ec71d3e2ef38c58f191eee653d40e2))

## [1.48.0](https://github.com/khaosdoctor/scriba/compare/v1.47.2...v1.48.0) (2026-09-27)


### Features

* **enrich:** add OpenCode Go/DeepSeek Flash as enrichment fallback ([#17](https://github.com/khaosdoctor/scriba/issues/17)) ([4ccdaa0](https://github.com/khaosdoctor/scriba/commit/4ccdaa05a01115b08623674077d94b2d0911fb9a))

## [1.47.2](https://github.com/khaosdoctor/scriba/compare/v1.47.1...v1.47.2) (2026-09-27)


### Bug Fixes

* **tasks:** lowercase work notes folder ([97c7cbe](https://github.com/khaosdoctor/scriba/commit/97c7cbe6057c6a7bb217e1363c661aaf6ba426ff))
* **tasks:** point work note default to notes/Work notes ([8074a82](https://github.com/khaosdoctor/scriba/commit/8074a829429114e8188e975edd873819e32b49a7))

## [1.47.1](https://github.com/khaosdoctor/scriba/compare/v1.47.0...v1.47.1) (2026-09-27)


### Bug Fixes

* **enrich:** treat unusable model output as a failed tier and reject blank PARAKEET_URL at boot ([b7149ee](https://github.com/khaosdoctor/scriba/commit/b7149eec4fe421d6f4e0b133f5260a03262422fd))

## [1.47.0](https://github.com/khaosdoctor/scriba/compare/v1.46.2...v1.47.0) (2026-09-27)


### Features

* fall back haiku -> sonnet -> groq for enrichment and groq -> parakeet for voice ([#16](https://github.com/khaosdoctor/scriba/issues/16)) ([9b26381](https://github.com/khaosdoctor/scriba/commit/9b263815dd8cd8c14564c238ca2ef1d8086efefe))

