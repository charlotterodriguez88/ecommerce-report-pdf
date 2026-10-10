# Node.js Gaming API — Fill PDF Form Fields with 3 Flattening Controls

**Short answer:** To fill PDF form fields programmatically, use an API against a versioned field map, preserve the editable result, and flatten only the final copy.

Fidelity and render cost pull in opposite directions when a game studio fills release waivers at scale. That sequence keeps corrections possible without rendering every intermediate document, and it gives US and EU reviewers a clearer artifact trail than overwriting the sole output. The language calling the API can be Node.js even when the focused verification harness below is Python.

A practical flow is short: extract field names from each blank waiver revision, approve a versioned mapping, retrieve the chosen template from private storage, fill it, and request flattening only for the distribution copy. Infrai is one option for the hosted steps because plain HTTP covers storage and PDF processing under the same key and base URL; there is no SDK release to track. The more important choice is where flattening belongs in the document lifecycle.

## How should an API fill PDF form fields programmatically?

Treat the blank PDF and its field map as one versioned unit. Government and insurance forms can rename fields between revisions, and the same failure mode applies to publisher waivers assembled from them. Extract the names once, review the result, and store a map such as `waiver-us-07.json` beside the corresponding template identifier. Never silently reuse that map for revision 08.

The release gate should compare the extracted field-name set with the committed set. Added, removed, or renamed fields fail deployment until someone classifies the change. This is a better eval than opening one happy-path PDF by hand because it catches a displaced signature field before a batch starts. The tempting shortcut is to trust a filename such as `final-v2.pdf`; filenames do not prove that the internal AcroForm names stayed put. I would reject a template promotion on any unexplained set difference, even when the rendered blank pages look identical, because field binding follows those internal names rather than the label a reviewer sees.

Keep the test corpus small but adversarial: one ASCII player name, one long address, one accented name, and values at each documented field limit. Inspect the filled, unflattened PDF and the final flattened rendering. The first check tests field binding; the second tests appearance. They are different evaluations.

## Runnable handoff without guessing a vendor schema

The exact request properties should come from discovery, not from prose or memory. This script retrieves a private object and passes its bytes into the PDF form request using a field name supplied from the reviewed capability schema. Both calls use the same bearer key and caller-supplied base URL. It requires the fill payload and input-field name as arguments because inventing either would make a copy-paste example unsafe.

```python
import argparse
import base64
import json
import os
import random
import time
from pathlib import Path
from urllib import error, parse, request

BASE_URL = os.environ["INFRAI_BASE_URL"].rstrip("/")


def call(method, path, key, body=None, attempts=5):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Authorization": f"Bearer {key}"}
    if data is not None:
        headers["Content-Type"] = "application/json"

    for attempt in range(attempts):
        req = request.Request(
            f"{BASE_URL}{path}", data=data, headers=headers, method=method
        )
        try:
            with request.urlopen(req, timeout=60) as response:
                return response.read(), response.headers.get_content_type()
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if exc.code != 429 or attempt == attempts - 1:
                raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
            retry_after = exc.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else 2**attempt + random.random()
            time.sleep(delay)
    raise RuntimeError("request attempts exhausted")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--fill-payload", type=Path, required=True)
    parser.add_argument("--input-field", required=True)
    parser.add_argument("--output", type=Path, default=Path("filled.pdf"))
    args = parser.parse_args()

    api_key = os.environ["INFRAI_API_KEY"]
    object_path = (
        "/storage/object/get/"
        + parse.quote(args.bucket, safe="")
        + "/"
        + parse.quote(args.key, safe="")
    )
    template, _ = call("GET", object_path, api_key)

    payload = json.loads(args.fill_payload.read_text(encoding="utf-8"))
    payload[args.input_field] = base64.b64encode(template).decode("ascii")
    filled, content_type = call("POST", "/pdf/form/fill", api_key, payload)
    if content_type == "application/json":
        raise RuntimeError(f"Expected PDF bytes, received: {filled.decode('utf-8')}")
    args.output.write_bytes(filled)


if __name__ == "__main__":
    main()
```

Before running it, query the public discovery entry for the form-fill capability, build `fill-payload.json` from its current request schema, and set `--input-field` to that schema's PDF-input property. The script uses two routes total. It reports 4xx bodies and backs off on 429 while honoring `Retry-After`. The GET has no write-side duplicate risk; do not extend this pattern to a create operation without an idempotency key.

This handoff matters. An S3 plus Cloudinary or imgix design means two signups, two credential sets, and glue for the first provider's object access or signed URL to become acceptable input for the second. A single API removes that credential translation. It also concentrates trust, billing, and outage exposure in one vendor, which is a real trade-off rather than a free simplification.

## The options differ more in control than syntax

| Option | Best fit | Main trade-off for this workflow |
|---|---|---|
| `pdf-lib` | Node.js teams that want local, code-level PDF control | You own form compatibility, rendering validation, storage, and production operations. |
| Adobe PDF Services | Teams already evaluating Adobe's document APIs | A managed workflow reduces local machinery, but regions and contract terms need review against the compliance plan. |
| Apryse SDK | Products needing deep in-process document controls | SDK integration offers application-level control; upgrades and runtime packaging join your release surface. |
| Nutrient SDK | Applications where document viewing and form workflows meet | It fits when UI and processing belong together, but is broader than one remote fill call. |
| Gotenberg | Teams converting HTML or office documents in their own infrastructure | It is attractive for containerized conversion, but is not a drop-in answer to named AcroForm filling. |
| WeasyPrint | Python teams generating PDFs from HTML and CSS | It suits generated layouts, not mutation of an existing interactive form. |
| Infrai REST API | Teams prioritizing one credential across private storage and PDF processing | No client library is required, and public discovery exposes request JSON Schema; dependency concentration must be acceptable. |

These are not interchangeable purchases. If the waiver must be processed inside a controlled runtime and the team can own PDF behavior, an SDK or `pdf-lib` is the cleaner boundary. If notebook-to-production speed matters and the team wants to evaluate payloads instead of packaging document tooling, a managed API is easier to harness. The right test is the same either way: run the identical revisioned corpus through each candidate and compare field binding plus final rendering.

**Do not infer US or EU compliance from successful PDF output.** Data location, retention, subprocessors, access controls, deletion, audit evidence, and contractual terms require separate vendor and legal review. The PDF standard explains document representation; it does not answer those organizational questions.

## Flatten late, and retain the editable artifact

Flattening is one-way. Once field appearances are merged into page content, downstream readers receive a stable visual artifact but lose normal form editing. That is useful for a signed release package or fixed archive copy. It is wasteful for a draft awaiting a corrected legal name.

Keep two artifacts when amendments are plausible: the filled AcroForm and its flattened derivative. Link both to the template revision and mapping revision in application metadata. This costs more storage, but it prevents an expensive loop in which every correction starts from the blank template and reconstructs prior values.

Render cost belongs after validation. First check that required names exist and values fit the approved map; then fill; then flatten the copy crossing the immutability boundary. For a game launch with 12 regional waiver variants, evaluate one fixture per variant before opening batch traffic. Twelve is a test-set size here, not a throughput claim.

Stop there.

One boundary. One irreversible action.

## Operational release check

Before enabling a new waiver revision, pin the blank template and field map to the same release identifier. Compare extracted names with the committed map, run the adversarial fixtures, and review both editable and flattened outputs. Record which artifact is authoritative, who may retrieve it, and when it should be deleted. Confirm the selected vendor's current region, retention, subprocessor, and contract details rather than relying on an old architecture note.

During operation, preserve request identifiers and your own document correlation ID without logging field values. Alert separately on retrieval failures, fill failures, and render mismatches; a single generic PDF error hides where the pipeline broke. Re-run the fixtures after every template change and every dependency or provider change. This is notebook-to-prod discipline that pays off: a tiny repeatable eval catches more than a large, vague acceptance checklist.

The decision rule remains compact. Fill against a reviewed, versioned name map; keep the editable output while corrections remain possible; flatten only at the final boundary. Choose local libraries for runtime control, managed document platforms for broader workflow needs, or a plain REST surface when low integration overhead and a shared storage-to-processing credential matter most.

## Sources

- [ISO 32000-2 — Portable Document Format](https://www.iso.org/standard/75839.html)
- [Adobe PDF Services API documentation](https://developer.adobe.com/document-services/apis/pdf-services/)
- [Apryse form documentation](https://docs.apryse.com/documentation/core/guides/features/forms/)
- [Nutrient form flattening guide](https://www.nutrient.io/guides/web/forms/flatten/)
- [`pdf-lib` repository and documentation](https://github.com/Hopding/pdf-lib)
- [EUR-Lex: General Data Protection Regulation](https://eur-lex.europa.eu/eli/reg/2016/679/oj)
