# Clean-room process

Open Arc reimplements Arc's *behavior*, never its code. Two roles, kept separate:

## Analysts
- Study Arc (the running app, its on-disk data files, and binary metadata) to document **what it does and how it stores the user's data**.
- Write only prose, JSON Schemas, and behavior descriptions into `spec/`.
- May include identifiers needed for interoperability: JSON keys, enum values, file names. Nothing else from the binary.
- Raw analysis output (disassembly, decompiled code, Evidence bundles, string dumps) stays **outside this repo** and is never shared.

## Implementers
- Build `exporter/` and `browser/` using **only `spec/`** and public documentation (Chromium, Electron, etc.).
- Never look at Arc's binaries, decompiled output, or analysts' private notes.

## Hard rules
1. No Arc binaries, frameworks, decompiled/disassembled code, or assets (icons, Lottie animations, sounds, fonts, images) in the repo.
2. No real user data in the repo. Examples and test fixtures are synthetic.
3. No copied UI strings or marketing copy. Write your own.
4. Every PR to `spec/` gets a second reviewer checking rules 1–3.

## Legal basis
Studying software you lawfully own to achieve interoperability with your own data is broadly permitted (e.g. 17 U.S.C. §1201(f); EU Directive 2009/24/EC Art. 6). This document is not legal advice.

## Project status note
While the project has a single maintainer, one person fills both roles. Implementation work is done from `spec/` alone, and anything learned during implementation goes back into `spec/` first. Once there are more contributors, new implementers should come from people who have never looked at the binary.
