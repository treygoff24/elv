# Model performance journal

Delegated model invocations for this repository. Each entry records the task,
result, and whether the output changed the work.

| Time (UTC) | Model | Task | Result | Usefulness | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-07-16 17:39 | Claude (Delegate safe, high) | Architecture and API-fidelity review of expansion plan | Succeeded in 444s | High | Found deterministic path-match collision, cache-authority gap, partial SSE preservation, dead resolved-budget config, and packaging omissions. Verdict: approve with revisions. |
| 2026-07-16 17:39 | Grok 4.5 (Delegate safe, high) | Adversarial security/product review of expansion plan | Succeeded in 142s | High | Found torn dual-cache design, secret/save-file policy gaps, overstated WS/STT support, budget ambiguity, and excessive alias surface. Verdict: approve with revisions. |
| 2026-07-16 18:20 | Claude (Delegate safe, high) | Round 1 architecture and API-fidelity review | Succeeded in 1,060s | High | Confirmed core coverage and found CLI dry-run flag loss, JSON escape parsing, RAG risk metadata, missing invocation deprecation warnings, one false alias inventory entry, and an unpinned docs-count requirement. |
| 2026-07-16 18:39 | Grok 4.5 (Delegate safe, high) | Round 2 security and trust-boundary review | Succeeded in 246s | High | Found protocol-relative API-key exfiltration and raw-path WS confirmation/budget bypasses, plus camelCase credential-key leakage. Verdict: reject until fixed. |
