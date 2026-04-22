# Recent Turns Parity Bridge - 2026-04-22

## Purpose

`recent_turns` is the first low-risk vNext packet/context section with fixture-backed parity support. This bridge lets local replay and preview flows carry explicit recent-turn fixtures through:

- `RetrievalOutputs.recentTurns`
- `TurnPacket.context.sections`
- `TurnPacket.dialogue.recentTurns`
- `PromptPreview.contextSections`

It does not fetch live session messages and does not affect `/api/chat`.

## Fixture Input

The replay harness accepts:

```bash
RECENT_TURNS_JSON='[
  {"role":"user","content":"previous question"},
  {"role":"assistant","content":"previous answer"}
]' pnpm tsx scripts/vnext-turn-replay.ts
```

or:

```bash
RECENT_TURNS_FILE=fixtures/recent-turns.sample.json pnpm tsx scripts/vnext-turn-replay.ts
```

Accepted fixture fields:

- `role`: `user`, `assistant`, or `system`
- `content`: string
- `text`: string fallback when `content` is absent
- `createdAt`: optional string
- `metadata`: optional object

Invalid rows are skipped. Ordering is preserved. There is no summarization, trimming, or live lookup.

## Current Mapping

`mapRecentTurnFixtures(...)` converts explicit fixture rows into canonical `DialogueTurn[]`.

`buildRetrievalOutputs(...)` can then receive:

```ts
{
  source: "replay_fixture",
  recentTurns: DialogueTurn[],
}
```

`composeTurnPacket(...)` creates a `recent_turns` context section only when `retrievals.recentTurns` has rows.

`renderPromptPreview(...)` marks `recent_turns` present only when the packet has that section.

## Live vs Fixture vs Unmapped

Fixture-backed:

- Recent turn rows in local replay.
- Packet section presence.
- Preview section presence.

Live:

- Nothing in this bridge is live.

Unmapped:

- Legacy message selection policy.
- Session DB reads.
- Summarization.
- Continuity richness.
- Memory mapping.
- Persona kernel and overlays.

## Section Comparison

Use the local comparator for section-key presence only:

```bash
LEGACY_SECTIONS=persona,recent_turns,memory \
VNEXT_SECTIONS=recent_turns \
pnpm tsx scripts/vnext-section-compare.ts
```

The comparator reports:

- `shared`
- `missingFromVNext`
- `extraInVNext`

It does not compare wording, ordering, semantics, or prompt quality.

## Interpretation

If `recent_turns` appears in vNext preview, it means fixture-backed dialogue rows were carried through the vNext packet. It does not prove legacy parity for which turns should be selected, how many turns should be included, or how legacy prompt assembly formats them.
