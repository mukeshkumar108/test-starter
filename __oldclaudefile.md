# Project: Walkie-Talkie Voice Companion (Memory Spine)

## Product Goal
This app is a voice-first thinking partner and mentor.
User presses and holds a button to talk, releases to send, and hears a spoken response.
The system maintains emotional continuity, project continuity, and decision continuity over time.

Primary UX use case: walking + talking + thinking out loud.

## Tech Stack (DO NOT CHANGE)
- Framework: Next.js App Router
- Auth: Clerk (all /app/* routes protected)
- DB: Neon Postgres
- ORM: Prisma v6 (already configured)
- LLM Router: OpenRouter
- STT: LemonFox (Whisper)
- TTS: ElevenLabs (streaming preferred)

## Core Architectural Pattern

### Two-Call Shadow Pattern
Every user interaction triggers:

1. FAST PATH (blocking):
   - STT
   - Context build
   - LLM response
   - TTS playback to user

2. SHADOW PATH (non-blocking):
   - Memory extraction
   - Summary spine update
   - Session state update

Shadow path must never block user audio response.

## Memory Model

There are four context layers:

1. Persona (static, from /prompts)
2. User Seed (static, per-user, stored in DB)
3. Session State (short-term, per conversation, overwritten freely)
4. Long-Term Memory (vectorized facts: PROFILE, PEOPLE, PROJECT, OPEN_LOOP)

Plus:
- Summary Spine: rolling compressed narrative of the conversation

Only latest summary is used at runtime, but older versions may be stored.

## Services Structure (MANDATORY)

All intelligence and memory logic must live in:

/lib/services/memory/

Examples:
- contextBuilder.ts
- shadowJudge.ts
- memoryStore.ts

API routes must be thin orchestration layers only.

## Prompt Management

All system prompts must live in:

/prompts/*.md

No prompt strings hardcoded in TypeScript.

## Profiles & Reskinning

Persona templates live in repo.
User-specific identity and seed context must live in DB.

Profile config defines:
- persona prompt path
- LLM model
- TTS voice
- language

## Persona Picker (v0.1 Requirement)

On app open (post-login), user must be able to choose from 3–5 preset personas (“mentors”).
Each persona has:
- persona prompt path (/prompts/*.md)
- LLM model name (OpenRouter)
- ElevenLabs voiceId
- language (en/es)

The chosen persona affects style/voice/model, but long-term memory + summary spine are shared per user.
Session state may be per persona (recommended) to avoid tone carryover.

## UI & Aesthetic Principles (High-End Minimalist)

The UI must feel emotional, alive, and premium — not like a utility dashboard.

### Core Interaction
- Single central interactive element (orb / button hybrid).
- Clear visual communication of system state:
  - IDLE
  - LISTENING
  - THINKING
  - SPEAKING

### Motion & Feedback
- Subtle motion is preferred over static UI.
- State changes should be animated (scale, glow, opacity, pulse).
- Animations must not block interaction or audio playback.
- Audio playback may optionally drive visual intensity (future enhancement).

### Design Style
- Dark-mode first.
- Soft glows, gradients, or blur allowed but must remain minimal.
- Avoid heavy glassmorphism or overdone neon effects.

### Mobile First
- Zero scroll layout.
- Thumb-centered interaction zone.
- Large hit targets.
- Haptic feedback if supported by platform.

### Progressive Enhancement Rule
For v1:
- Prioritize responsiveness and clarity over visual complexity.
- Implement simple animated states first.
- Advanced visualizers and effects may be added later.

Do not introduce animation systems that complicate the voice pipeline.

## Performance Requirements

Latency is critical.
Audio playback should begin as soon as partial LLM output is available if possible.

## Forbidden Patterns

- No business logic in React components
- No memory logic inside API routes
- No direct prompt strings in code
- No blocking memory writes before responding to user

If unsure, prefer simpler implementation over clever abstraction.
