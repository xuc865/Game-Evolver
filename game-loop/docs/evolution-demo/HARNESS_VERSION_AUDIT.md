# Harness-Version Audit

This audit records the actual agent-harness versions behind the evolution history. A different epoch number is not treated as a different harness unless its profile snapshot or task/probe contract changed.

## Verified Profile Changes

### Chudopoly

The current Codex continuation chain has one accepted candidate profile (`profile-b4fe0f3d...`). The older v2 history has distinct fork-worker profiles at epochs 10, 13, and 14, but those candidates were not accepted. They can be shown as rejected harness experiments, not as a monotonic accepted-quality sequence.

### Canvas Vampire Survivors

Accepted profile transitions are visible from the early Codex profile (`profile-b4fe0f3d...`) to the later evolved profile (`profile-d4b0b537...`). The v2 history contains additional distinct profiles, but not all were accepted.

### Iron Breakout FPS

The accepted history contains several real profile transitions: the earlier Codex profile (`profile-9d7a33f...`), the source-Codex profile (`profile-b4fe0f3d...`), the evolved implementation-worker profile (`profile-3ea90a3...`), and later deep-probe profiles in the v3 history.

### PolyBranch

The history contains multiple accepted profile transitions in the v2/v3 runs, followed by the dedicated remediation task in `polybranch-remediated`. The remediation is a genuine harness change: deterministic score/popup hooks, page-context fixes, a single bounded probe, and a hard stop after browser failure.

## Important Limitation

It is not truthful to claim four different accepted harness versions for every game. In particular, Chudopoly does not have four accepted profile transitions in the recorded history. The presentation should either show rejected harness experiments explicitly or use fewer than four Chudopoly accepted anchors. Repeating a later workflow diagram at different epochs would misrepresent the evidence.
