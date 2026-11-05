# Evaluation set

`events.jsonl` holds 45 past U.S. government actions (d01 to d51, with gaps), 135 company and action pairs in all. Each one has a topic (`category`), the S&P 100 companies whose own 10-K Risk Factors describe exposure to that kind of action (`expected`), and the search terms used to check this (`terms`).

How the expected companies were chosen (November 2026):

1. A first draft was written from general knowledge.
2. `scripts/check-set.mjs` searched every company's latest 10-K Risk Factors for each event's terms. It has no model in the loop.
3. Expected companies were kept only if their filing mentions the terms. Companies that mention them clearly and are directly affected were added. One event (open banking data rights) was dropped because no filing addressed it.
4. A second batch of 33 actions from 2024 to 2026 (d19 to d51) went through the same check on November 5, 2026. Five were dropped because no filing named them: copper tariffs, the de minimis suspension, the FTC click-to-cancel rule, Section 301 port fees, and the aircraft Section 232 investigation.

Limits: term matching misses companies that describe the same exposure in other words. It also ignores risks discussed outside Item 1A, such as PepsiCo's "Our Business Risks" in MD&A. The expected lists are a floor, not a complete answer.
