# Weekly Clinical Invoice PDF Report Generation: Template Governance Across API Boundaries

Keep the invoice template in the application team's repository, and treat the PDF renderer as a replaceable execution boundary. That choice fits a weekly healthtech billing run because the decisive constraint is ownership: finance and engineering need to review the exact document logic that turns order data into an invoice, while the rendering API should receive a frozen input rather than silently define business meaning.

**TL;DR:** schedule a durable batch job, snapshot each eligible order, bind that snapshot to an immutable template version, and submit an idempotent render request. Validate the returned bytes and reconcile a manifest before delivery. A direct “query current orders and print them every Monday” script is attractive in a notebook, but it cannot explain which data and template produced a disputed invoice later.

## How should a scheduled PDF report generation API own templates?

An invoice is a business record expressed as a document. The renderer may handle pagination, fonts, and PDF serialization, but it should not decide how refunds are displayed, which service date appears, or whether a patient-facing identifier is allowed on the page. Those decisions belong beside the code and review process that owns the order schema.

Template ownership makes the boundary inspectable. A change from `invoice-v12` to `invoice-v13` can travel through code review with a fixture showing the intended difference. The scheduled job can retain the version identifier with the input snapshot and output digest. If rendering moves from an in-process library to a remote worker, the invoice rules do not have to move with it. This also draws a useful line around the word “template.” Layout, labels, and conditional presentation belong there; calculation policy and eligibility do not. A template may display a supplied `total`, but it should never discover billable orders or recalculate that total from a live table. Otherwise the repository appears to own the document while the decisive logic remains hidden inside the rendering step.

The trade-off is real: the application team now owns layout regression tests and font assets. Handing templates to a rendering service may reduce that maintenance, but it also places document behavior behind a second configuration surface. For clinical billing, I would accept the test burden because unauthorized data exposure and unexplained totals are much more consequential than saving a few template commits.

Keep the contract narrow. The render boundary needs a template artifact, normalized data, deterministic locale and time-zone settings, and a correlation identifier. It should return a PDF or a terminal failure with enough structured context for the caller to classify it. It does not need live database access.

That boundary is the point.

## Freeze the run before rendering

The simple approach selects all orders with `status = billable`, renders each one, and emails the results in a single process. It fails awkwardly when an order changes halfway through the run: early PDFs reflect one database state, later PDFs another, and a retry may create a third set. Delivery becomes coupled to rendering too, so a transient mail failure can encourage regeneration of an already-correct document.

A better weekly run has three separate records: a run manifest, an invoice snapshot per order, and a delivery record per finished artifact. Consider a concrete operating rule: at `09:00 UTC` on Monday, the scheduler creates `run-2026-10-05`, records the cutoff instant, and selects eligible orders. An order corrected at `09:03 UTC` does not mutate that run's snapshot; the correction follows the finance team's explicit adjustment policy instead. A worker that starts at `09:20 UTC` reads the frozen row, renders `invoice-v13`, stores the PDF by artifact identifier, and appends its digest to the manifest. If delivery fails at `09:30 UTC`, the system resends the stored bytes. It does not query the order again. These times and identifiers are examples of a policy, not universal settings, but they expose the ownership decisions that a vague “weekly cron” description conceals.

One rule matters more than it first appears: money enters the snapshot as decimal text in a declared currency, never as binary floating-point values. Dates also carry their intended semantics. A service date is a date; a run cutoff is an instant with an offset. The renderer should not infer either from the machine clock.

No clock reads.

The following focused example prepares a renderer-neutral request and verifies the response. The `render` callable could invoke a local worker or an HTTP adapter; the orchestration code does not care.

```python
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from hashlib import sha256
import json
from typing import Callable


@dataclass(frozen=True)
class InvoiceSnapshot:
    invoice_id: str
    order_id: str
    service_date: str
    currency: str
    subtotal: Decimal
    tax: Decimal

    def as_payload(self) -> dict[str, str]:
        total = self.subtotal + self.tax
        return {
            "invoice_id": self.invoice_id,
            "order_id": self.order_id,
            "service_date": self.service_date,
            "currency": self.currency,
            "subtotal": format(self.subtotal, ".2f"),
            "tax": format(self.tax, ".2f"),
            "total": format(total, ".2f"),
        }


def canonical_json(value: dict[str, str]) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")


def render_invoice(
    snapshot: InvoiceSnapshot,
    template_version: str,
    render: Callable[[dict[str, object], str], bytes],
) -> tuple[bytes, dict[str, str]]:
    payload = snapshot.as_payload()
    input_digest = sha256(canonical_json(payload)).hexdigest()
    idempotency_key = sha256(
        f"{snapshot.invoice_id}:{template_version}:{input_digest}".encode("utf-8")
    ).hexdigest()

    pdf = render(
        {"template_version": template_version, "data": payload},
        idempotency_key,
    )
    if not pdf.startswith(b"%PDF-"):
        raise ValueError("renderer returned a non-PDF payload")

    evidence = {
        "invoice_id": snapshot.invoice_id,
        "template_version": template_version,
        "input_sha256": input_digest,
        "output_sha256": sha256(pdf).hexdigest(),
        "idempotency_key": idempotency_key,
    }
    return pdf, evidence
```

This is intentionally not a complete billing system. For example, the arithmetic assumes tax was already determined by an upstream billing rule and does not invent rounding policy inside the document layer. The important part is the evidence chain: invoice identifier, exact normalized input, template version, and output digest.

## Separate retries from business decisions

| Stage | Durable input | Success evidence | Safe retry action |
| --- | --- | --- | --- |
| Snapshot | Run cutoff and eligible order | Input digest in manifest | Reuse the snapshot |
| Render | Snapshot and template version | PDF digest and validation result | Reissue the same idempotency key |
| Deliver | Immutable artifact identifier | Delivery record | Resend the stored artifact |

Weekly does not mean “run one process for a long time.” Enqueue one job per snapshot and give every job an explicit state such as `ready`, `rendering`, `validated`, `delivered`, or `failed_terminal`. A lease with an expiry lets another worker recover abandoned work. The idempotency key prevents a retry from becoming a new logical render, provided the adapter and storage layer enforce that contract.

Retry only failures classified as transient. A timeout may qualify. A missing required field, unknown template version, or total mismatch does not; repeated execution cannot repair invalid input. Put those cases in a review queue with the run identifier, invoice identifier, and stable error code, while keeping sensitive order fields out of routine logs.

Three attempts is a reasonable starting policy, not a universal truth. Measure the renderer's observed recovery pattern before choosing attempt count and backoff. Also cap concurrency. An unbounded Monday batch can overload the renderer, object store, or downstream delivery channel even if each component looks healthy in isolation.

Rendering and delivery need different idempotency domains. A validated PDF should be stored under an immutable artifact identifier. If delivery fails, retry delivery of that artifact rather than rendering again.

Small distinction, large payoff.

## Evaluate documents, not successful requests

An HTTP success status says almost nothing about invoice correctness. Start the evaluation harness in the notebook, but commit its fixtures and assertions before the first scheduled run. Include an ordinary single-page order, a long description that wraps, a multi-page line-item set, a refund or negative adjustment allowed by the billing model, and characters required by the supported names and addresses.

The first layer is structural: non-empty output, a PDF header, expected page-count bounds, and parseable metadata where the implementation exposes it. The second layer extracts text and checks invariant fields such as invoice ID, currency, service date, and formatted total. The third layer renders selected pages to images for visual regression. Pixel tests are sensitive to font and renderer changes, so compare them in a pinned environment and maintain a deliberate approval path.

Do not stop there. Recompute totals from the snapshot and compare them with extracted document text. Check that prohibited fields are absent. Confirm that page two retains enough invoice identity to be separated and reconciled. PDF is standardized by ISO 32000-2 [1], but conformance to a file format does not prove that a particular invoice contains the right facts.

I would gate template promotion on the fixture suite, then canary a small deterministic subset of a run before releasing the remaining jobs. “Small” must be selected for coverage, not optimism: include the longest invoice and every supported locale present in that manifest. This keeps the feedback loop prompt-cost aware too; any AI-assisted classification belongs before the frozen snapshot and must be evaluated independently, rather than invoked once per rendering retry.

## Operate the weekly batch as a reconciliation

The primary dashboard should describe business progress, not raw request volume. For each run, track the number of frozen snapshots, validated PDFs, terminal failures, and successful deliveries. Those counts must reconcile. Track queue age and end-to-end completion separately from renderer latency because a fast renderer can still sit behind a stalled queue.

Record identifiers and digests in the manifest, not document contents in logs. Access to snapshots and artifacts should follow the system's clinical and financial data controls, with retention defined by the organization's legal and records policies. The PDF generator cannot choose those periods responsibly.

Alert on stuck leases, a rising terminal-failure ratio, manifest count mismatches, and delivery backlog. Avoid alerting on one failed render; the state machine already knows how to retry a transient failure. Operators need a safe replay action scoped to a run and state, plus a dry-run view that shows how many records would move.

Before copying this design, measure five things in a representative batch: invoices per run, page-count distribution, peak rendered-byte volume, time from cutoff to reconciled delivery, and fixture failure rate for a candidate template. Also measure how often finance needs to revise a template without an application release. If that final number is high and review controls are strong, a separately managed template repository may be a better ownership model. The renderer still should not own the billing rules.

The decision is therefore conditional but crisp: own templates where invoice meaning is code-reviewed with the order model; delegate rendering mechanics behind a narrow, idempotent contract. Freeze first, render second, reconcile last. That structure makes the scheduled API replaceable while keeping the document explainable.

## References

1. ISO, “ISO 32000-2 — Portable Document Format”: https://www.iso.org/standard/75839.html
