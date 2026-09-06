# Learning from our own work, with gates that can fail

Research notes behind `learnings.ts`. The question: how does an agent system
learn from what it did, without teaching itself something false?

## What everyone agrees on

Five sources, none of them ours, describe the same lifecycle:

    extract  ->  admit  ->  verify  ->  promote / demote  ->  retire

The interesting stages are the two in the middle, because they are the only
ones that can say no.

**Admission gates** decide whether a candidate is allowed into the store at
all. SSGM (arXiv 2603.11768) names four mechanisms: validate before insertion,
cross-reference against what is already stored, require evidence or a
confidence score, and record provenance so an entry can be traced to the
interaction that produced it.

**Replay verification** decides whether an admitted candidate actually helps.
The pattern reported across the agent-evaluation literature is a paired A/B
replay: run the agent with and without the candidate over a fixed set, compute
the delta on the metric, and admit only on a positive result. One description
of it — "a candidate memory is extracted and evaluated via paired A/B replay
(Original vs. Injected), computing delta Reward, delta Latency, delta Tokens,
with an admission gate accepting the item if the score is positive" — is
exactly the shape we can implement, because we already have the replay set.

The rest is lifecycle. Promote what keeps earning its place, demote what stops,
retire what goes stale or starts contradicting something newer.

## What everyone warns about

The failure modes are reported consistently enough to design against directly:

| failure | what it looks like here |
|---|---|
| self-reinforcing error | the reviewer concludes a pattern is noise, stops raising it, and never gets the feedback that would correct it |
| over-generalisation | one dismissed comment becomes a rule that suppresses a whole category |
| repository overfitting | a rule true of one codebase applied to all of them |
| stale learnings | a rule about code that no longer exists |
| conflicting learnings | two active rules that cannot both be followed |
| feedback noise | an engineer who says "fixed" to close a thread, not because the finding was right |

The last one is not hypothetical. Measured on our own corpus, test-assertion
findings are acted upon 94% of the time and marked noise 94% of the time: an
author widens an assertion because it is cheaper than arguing. A learning
system that reads "acted upon" as "was right" learns to produce more of the
least valuable finding we make. Our own prompt carried a rule that did exactly
this, justified by the act rate, until the noise rate was measured beside it.

So an outcome signal is evidence, not truth, and the gate has to be able to
disagree with it.

## What we have that the papers assume

Most of this literature treats the replay gate as the hard part, because a
general agent has no fixed task set to replay against. We do:

- 359 harvested review comments across 18 pull requests
- 136 of them confirmed as real defects by the engineer who fixed them
- a scoring harness that replays any commit and reports recall and precision
- an independent judge that matches findings by reading the code

That turns the strongest gate in the literature from an aspiration into a
`bun test`. A proposed learning about reviews can be run against the corpus
with and without it, and rejected on the number.

## What this rules out

**No silent self-modification.** A learning changes behaviour only after it
passes its gates, and every gate result is stored with the learning. The reason
a rule is active is auditable after the fact.

**No learning from a single incident.** One dismissed comment is an anecdote.
The admission gate requires independent signals from more than one pull
request before a candidate is considered at all.

**No unbounded growth.** Every active learning costs prompt budget on every
run, so the store is capped and entries compete. A learning that stops earning
its place is demoted rather than accumulated.

## Sources

- SSGM, governing evolving memory in LLM agents (arXiv 2603.11768) — admission
  gates, contradiction detection, provenance, expiry, retention validation
- Feedback-normalised developer memory, safety-gated (arXiv 2605.01567) —
  weighting signals by how well the source predicts outcomes, and the four
  failure modes above
- Memory for autonomous LLM agents (arXiv 2603.07670) — mechanisms and
  evaluation survey
- SEAGym (arXiv 2606.17546), SKILL.nb (arXiv 2606.08049) — promote, formalise,
  repair, demote, retire as explicit lifecycle states
- Reflexion — reflective text in episodic memory as the original form of this,
  and the source of the self-reinforcing-error risk
