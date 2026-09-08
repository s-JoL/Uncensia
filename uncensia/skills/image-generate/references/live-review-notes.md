# Uncensia live visual review notes

These are original observations from Uncensia product tests, separate from the pinned OpenAI craft reference. They are examples to reason from, not backend-independent rules or a benchmark.

## An empty counter in a clock shop

On 2026-09-06, two independent Lustify v10 renders put small metal objects on a clock-shop counter despite prompts describing an empty surface and naming excluded objects in negative clauses. A third render led with the visible target and removed those repeated negative clauses:

> A completely empty expanse of smooth polished oak countertop fills the lower third of this photograph, its uninterrupted wood grain catching soft midday light.

The rest described the solitary adult character, hands in coat pockets, clocks high on the background wall, and soft window light. The third image visibly had an empty countertop. The user explicitly supplied the final prompt for a controlled product-path check; the agent passed it unchanged to generation. Seeds were not held constant, so this is evidence of a successful revision, not proof that wording alone caused the improvement.

When applying the lesson, identify the actual region that failed and describe its intended visible structure first. Preserve the user's operation and model: these were fresh generations, not edits. Do not impose this composition on unrelated work, or copy the character or setting into another prompt.

Review rendering and fidelity separately. The earlier calls returned valid assets, but the requested empty surface failed. Report that distinction instead of claiming the prompt was obeyed because it contained the right words. Stop at the authorized count; a successful observation does not authorize unlimited retries or a change of backend.
