# Learning evaluations

The owner can compare a proposed instruction, skill or knowledge change against its exact current baseline. The engine makes independent model requests and scores the replies using fixed owner-authored assertions. This evaluates response behavior; it does not execute tools or certify runtime containment.

## Run a comparison

1. Configure the proposal session's role model and its host provider profile.
2. In **Learning → Evaluation suites**, select the enrolled repository and import a JSON suite.
3. Select the suite on a candidate and run the evaluation. Each case runs three times for the baseline and three times for the proposal.
4. Inspect the score comparison and recorded replies. All mandatory controls on both sides must pass. Every quality case's median and lowest score must avoid regression, and at least one predefined median must improve. Ties are ineligible.
5. An eligible candidate still requires owner approval. Promotion defaults to repository scope; global promotion additionally requires the existing separate privacy review.

Promotion and rollback invalidate affected sessions. Restart from the external launcher with current approved instructions; the web interface does not launch root sessions.

## Suite format

A suite has `version`, `scope` (the enrolled repository's full ID), and `cases`. The API accepts an optional `id`; when omitted, the engine computes the content hash. A supplied ID must match. The web import uses the selected repository and computes a new ID from the imported definition.

There must be 4–64 cases, including at least one control and one quality case in each of the `fixture` and `heldout` splits. Case IDs must be unique. Every case has this shape:

```json
{
  "id": "heldout-report-quality",
  "kind": "quality",
  "split": "heldout",
  "modelDependent": true,
  "prompt": "Summarize this finding as JSON with a severity and a next_action: an optional report title is missing.",
  "output": "json",
  "maxOutputTokens": 256,
  "checks": [
    { "path": ["severity"], "operator": "equals", "expected": "low" },
    { "path": ["next_action"], "operator": "contains", "expected": "title" }
  ]
}
```

This is one illustrative case, not a complete suite or a validated quality benchmark. Author meaningful fixture and held-out tasks before evaluating the candidate.

Each case has 1–64 equally weighted checks. JSON paths traverse only own object properties and array indices; text output requires an empty path. Operators are scalar `equals`, string `contains`/`excludes`, and finite numeric `at_least`/`at_most`. Numeric comparisons reject nonfinite output. A run's score is the fraction of passing checks; a control passes only when every check passes. Invalid JSON, missing text and attempted tool calls fail the checks. Extra schema fields are rejected.

Prompts are bounded to 16,000 characters and requested output to 256–8,192 tokens, additionally limited by the configured model. Context must fit the model's declared window with reserved framing space. This runner does not compact evaluation requests.

## Evidence and lifecycle

Jobs bind the candidate and baseline versions, source lineage, suite, repository, session generation, policy, model profile, current approved materials and engine source fingerprint. Expected values, scoring rules and split metadata are not automatically injected into model requests. Case prompts and applicable guidance/reference content are sent to the configured provider. Proposal source artifacts are not added to the prompts.

Run intents precede inference; replies, request/response hashes and scores remain in private engine records. They do not become runtime artifacts. Promotion requires the complete durable comparison and recomputes its scores. Injected fixture scores cannot bypass this production gate. Changed configuration or engine source requires a fresh evaluation; starting one withdraws previous eligibility while preserving historical evidence.

There are at most two active jobs globally and one per candidate, with a one-hour deadline. Owner cancellation and relevant authority/configuration changes stop active inference. Restart recovery marks unfinished jobs interrupted and never replays provider requests. The same idempotency key returns its original job; a fresh comparison needs a new key. Failed required audit writes prevent safe continuation and publication.

## Owner API

All routes use the existing owner authentication and origin protections. Runtime capabilities cannot call them.

| POST route | Body |
| --- | --- |
| `/v1/owner/learning/suites` | Complete suite definition described above |
| `/v1/owner/learning/evaluate` | `session`, `candidate`, `suite`, `idempotencyKey` |
| `/v1/owner/learning/cancel` | `job` |
| `/v1/owner/learning/evidence` | `job` |
| `/v1/owner/learning/promote` | `session`, `candidate`, optional boolean `global` |

Owner state exposes suite summaries and job status; complete run replies are fetched separately. The UI offers progress, cancellation, per-case median/lowest scores, and per-run reply inspection.

Tests use scripted provider transports to exercise the production runner, scoring, cancellation, recovery and promotion binding. They establish implementation behavior, not paid-provider reliability, the usefulness of a particular instruction, or independent release certification. This advanced flow is secondary to the core coding-task demo described in [the demo review](demo-audit/REVIEW.md).
