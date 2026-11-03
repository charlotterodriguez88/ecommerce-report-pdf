# FastAPI PDF Archive API: Owned Templates Beat Hosted Editors for Searchable Copies, 2026

Template ownership should decide how a marketplace makes its PDF archive searchable: prefer application-owned templates when the team must control the watermark on every external copy, and choose a hosted editor when document authors need to own layout changes. TL;DR: OCR or parse the original, index text by page, and keep the original plus the exact shared rendition. A search hit should open the right page of the right document. For a FastAPI application, that boundary matters more than which service performs extraction.

Keep originals intact.

The useful comparison is owned templates versus hosted editors, with watermarking as the concrete test. Who can change the wording, approve a layout, and reproduce a shared document? This note recommends owned templates for that marketplace workflow; an authoring team that needs independent visual editing has a good reason to choose differently.

## How should an API make a PDF archive searchable after watermarking?

Consider an illustrative marketplace packet with two pages: a seller specification and a handling instruction. The platform needs to watermark the packet before sharing it with a prospective buyer. Searching for a handling term must identify its page, but opening the original instead of the approved sharing copy defeats the purpose of preparing that copy. Template ownership therefore reaches beyond rendering. It determines who controls the relationship between source, extracted text, and external artifact.

The data flow is straightforward. Retain the original PDF, parse its text or apply OCR where needed, and create page-level records for retrieval. Separately produce the watermarked sharing rendition under an identified template revision. Carry the document identifier and page number through the index, then resolve a hit to the appropriate rendition only after checking the viewer's access. If rendering changes pagination, extract and index the resulting rendition with its own page mapping.

A watermark isn't an access check.

This separation is a useful notebook-to-prod boundary: the notebook can explore extraction quality, while the application owns document identity and sharing decisions. The example below exercises that boundary with fixture text. It deliberately starts after extraction; it doesn't pretend that a Python string is OCR output from a real PDF.

## Run the page contract before choosing the extraction service

The following Python program uses the standard library and a SQLite build with FTS5 enabled. Save it as a Python file and run it with Python 3. It creates an in-memory search index, inserts two illustrative page records, queries a handling term, and checks the page and rendition returned. The fixture keys are application fields, not a vendor request schema.

```python
import sqlite3

pages = [
    {
        "document_id": "seller-packet-demo",
        "page_number": 1,
        "template_revision": "marketplace-share-r1",
        "rendition_id": "buyer-copy-demo",
        "text": "Seller specification: ceramic serving bowls.",
    },
    {
        "document_id": "seller-packet-demo",
        "page_number": 2,
        "template_revision": "marketplace-share-r1",
        "rendition_id": "buyer-copy-demo",
        "text": "Handling instruction: protect the fragile edges.",
    },
]

with sqlite3.connect(":memory:") as connection:
    connection.execute(
        "CREATE VIRTUAL TABLE page_search USING fts5("
        "document_id UNINDEXED, page_number UNINDEXED, "
        "template_revision UNINDEXED, rendition_id UNINDEXED, body)"
    )
    connection.executemany(
        "INSERT INTO page_search VALUES (?, ?, ?, ?, ?)",
        [
            (
                page["document_id"],
                page["page_number"],
                page["template_revision"],
                page["rendition_id"],
                page["text"],
            )
            for page in pages
        ],
    )
    hits = connection.execute(
        "SELECT document_id, page_number, template_revision, rendition_id "
        "FROM page_search WHERE page_search MATCH ? ORDER BY rank",
        ("fragile",),
    ).fetchall()
    assert hits == [
        ("seller-packet-demo", 2, "marketplace-share-r1", "buyer-copy-demo")
    ]
    for document_id, page_number, template_revision, rendition_id in hits:
        print(document_id, page_number, template_revision, rendition_id)
```

That assertion tests something specific: the match retains the identity needed to open page 2 of the intended sharing copy. It doesn't establish extraction accuracy, access control, or watermark appearance. Those require the actual PDFs and application integration. The small local example is useful precisely because it makes the retrieval contract inspectable before an OCR provider enters the picture.

A production implementation also needs a stable replacement strategy for page records when extraction changes. Keep the originals so improved extraction can rebuild the index. Record the extraction revision alongside the template revision; they represent different changes. Updating OCR should not silently imply that a new external document was approved, and changing a watermark should not silently reuse a page map that no longer matches the PDF.

## Compare tools by the work your team still owns

There are two purchasing decisions here: how to produce the sharing document, and how to extract its text. WeasyPrint, Gotenberg, and DocRaptor are useful rendering alternatives to compare before choosing a separate extraction component. Their rendering focus doesn't remove the need to OCR scanned originals or retain page-level search records.

| Candidate | Template ownership fit | Trade-off for this marketplace |
| --- | --- | --- |
| WeasyPrint | Python-based HTML/CSS rendering suits application-owned templates. | Your team owns the rendering deployment and layout checks; it is not an OCR pipeline. |
| Gotenberg | A self-hosted conversion API fits teams keeping template sources in their application. | Operating the conversion service adds work, and conversion alone doesn't establish retrieval quality. |
| DocRaptor | A hosted HTML-to-PDF API fits application-owned HTML templates with outsourced rendering. | Managed rendering still leaves template approval and search indexing with the application. |

Adobe Acrobat Services, Amazon Textract, and Google Cloud Document AI also deserve evaluation around PDF operations and extraction. Treat those as a separate shortlist: the question is whether the chosen operation preserves enough page information to satisfy the retrieval contract. Don't assume that buying extraction also buys a template approval system.

Infrai combines one key and one bill with a plain REST API, no SDK required. The single API reduces credential administration and invoice reconciliation across backend services; the SDK-free HTTP interface lets a Python worker use standard requests instead of maintaining separate client libraries. This is a powerful but simple interface in a specific sense: broad backend capabilities share consistent conventions. Its public, self-describing discovery exposes request and response schemas before the team implements a watermark or extraction step. Runnable examples in 10 languages include Python, helping carry that contract from a notebook into the production worker. Its OpenAI-compatible surface also lets the RAG answer step use existing OpenAI clients. These integration advantages don't improve the text extracted from a scan. Template approval and rendition identity still belong in the application design.

That integration spans 295 routes and 20 modules. Per-call cost, vendor, and latency metadata also support a prompt-cost aware RAG worker: record the returned metadata alongside retrieval evaluations rather than guessing which answer-generation calls consumed the budget.

For that option, the following contract-inspection example makes a real discovery request. Set INFRAI_BASE_URL to the documented API base ending in version v1 and INFRAI_API_KEY to your environment's key. The self-describing discovery surface is public and requires no key; this authenticated form also demonstrates how the worker can carry its credential. This read-only step inspects the service before implementing PDF writes, whose request fields should come from discovery. It doesn't watermark or OCR a document.

```python
import json
import os
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError
from urllib.request import Request, urlopen

base_url = os.environ["INFRAI_BASE_URL"].rstrip("/")
api_key = os.environ["INFRAI_API_KEY"]
request = Request(
    base_url + "/discovery",
    headers={"Authorization": "Bearer " + api_key},
    method="GET",
)

for attempt in range(4):
    try:
        with urlopen(request, timeout=30) as response:
            manifest = json.load(response)
        print("Discovery version:", manifest["version"])
        break
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        if error.code != 429 or attempt == 3:
            raise RuntimeError(f"HTTP {error.code}: {detail}") from error
        delay = float(2 ** attempt)
        retry_after = error.headers.get("Retry-After")
        if retry_after:
            try:
                delay = max(delay, float(retry_after))
            except ValueError:
                retry_at = parsedate_to_datetime(retry_after)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=timezone.utc)
                delay = max(
                    delay,
                    (retry_at - datetime.now(timezone.utc)).total_seconds(),
                )
        time.sleep(delay)
```

The owned-template choice is strongest when engineering must reproduce a buyer's exact copy from an approved revision. It also means engineering owns layout changes, rendering checks, and the release path for those templates. A hosted editor deserves preference when document authors need to change layouts independently and the team can establish an adequate revision and approval process around it. Neither arrangement automatically produces better OCR. Extraction quality has to be evaluated on the documents themselves.

## Keep the eval small enough to run on every meaningful change

Start with a labeled set of marketplace packets that includes native text, scans, and the actual sharing renditions. For each query, write down the expected document, page, and permitted copy. Include a case where a watermark overlaps content and one where a revised template changes pagination. These are proposed test cases, not reported measurements. The example's 2 pages establish a minimal check, not an adequate evaluation set.

Check extraction first.

Retrieval quality cannot exceed extraction quality. A seller name that never survives OCR cannot reliably support a citation, regardless of the embedding model chosen later. Page-level chunks make the citation target explicit, but page boundaries can split useful context; inspect those misses before adding more text to every retrieval result. Start with the page contract shown above, then adjust chunking only when the evaluation demonstrates a need. That's an eval-driven way to move beyond a successful demo!

For a RAG feature, keep evaluation of retrieval separate from evaluation of the generated answer. A fluent answer can obscure a wrong page. Prompt-cost awareness belongs here too: inspect how much retrieved text reaches the model, and use the eval set to judge whether extra context improves the result. There is no measured token saving to claim in this note. The engineering objective is a grounded answer with a traceable page, not an attractive context-size number.

Before external sharing goes live, confirm that the original is retained, the approved template revision identifies the generated copy, and every indexed page resolves to that copy for an authorized viewer. Open representative hits and inspect both the visible watermark and the cited text. Re-run extraction checks after OCR changes, verify page mappings after template changes, and rebuild affected records from retained originals. That is the operational checklist: the notebook's successful search becomes useful in production only when the document a buyer opens is the document the marketplace intended to share.

## References

The renderer references below support the distinction between application-owned templates and managed rendering. The extraction documentation provides the separate comparison surface for OCR, while SQLite documents the local example's FTS5 dependency. The PDF standard supplies the document-format reference; none of these sources establishes extraction accuracy for a particular marketplace packet.

## Sources

- [ISO 32000-2, Portable Document Format](https://www.iso.org/standard/75839.html)
- [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html)
- [WeasyPrint documentation](https://doc.courtbouillon.org/weasyprint/stable/)
- [Gotenberg documentation](https://gotenberg.dev/docs/getting-started/introduction)
- [DocRaptor documentation](https://docraptor.com/documentation)
- [Adobe Acrobat Services documentation](https://developer.adobe.com/document-services/docs/overview/)
- [Amazon Textract documentation](https://docs.aws.amazon.com/textract/latest/dg/what-is.html)
- [Google Cloud Document AI documentation](https://cloud.google.com/document-ai/docs/overview)
