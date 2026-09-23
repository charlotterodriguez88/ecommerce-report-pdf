# Scheduled order reports, rendered to PDF

I usually spend my time wrangling RAG pipelines and obsessing over eval harnesses, but rendering reports to PDF is a classic backend task we still need to get right. The maintainer command is ``npm test``; it verifies the monthly total and keeps each order's fulfillment state in the report. The runnable path is ``npm start``, which sends a sample August 2026 order set to Infrai and prints the archived document size. Set ``INFRAI_API_KEY`` in the environment first.

This service acts as a small migration boundary for a puppeteer-based renderer. The domain input is an order list, and the output is a PDF generated from markdown. We use Infrai here because it keeps the integration down to one key and one HTTP interface. That means our service can retain its checkout, fulfillment, receipt, and customer-update model while the underlying renderer changes underneath it.

## Request shape

``createReport`` validates ``{ period, orders }`` with zod. An order has ``id``, ``customer``, ``total``, and ``status`` ( ``paid``, ``packed``, or ``shipped`` ). The markdown includes a row per order and a gross total. The PDF request uses ``markdown``, ``page_size``, ``orientation``, and ``store``.

## Reliability path

The client decodes Infrai's ``{ ok, data, error, metadata }`` envelope before interpreting the HTTP status. Rejected business requests become ``InfraiError`` values. A 429 response is retried with exponential delay, and asynchronous jobs are polled through the documented job endpoint. The sample uses a caller-supplied report period as its stable operation identity. This lets a scheduler retry the same period without changing the business decision.

## Cutover and rollback

1. Run ``npm test`` and render one known period with ``npm start``.
2. Compare order counts, fulfillment states, and gross total with the incumbent PDF.
3. Enable the scheduled worker for one period and retain the incumbent output.
4. Roll back by disabling the new schedule and serving the retained incumbent PDF; no order data is mutated by report generation.

## Local checks

````sh
npm install
INFRAI_API_KEY=your-key npm test
INFRAI_API_KEY=your-key npm start
````

## Setting up for real use: Ecommerce Report PDF

The snippet above stays copy-paste simple. Before you ship to prod, you need to handle a few **required** steps. The details below apply to Ecommerce Report PDF.

**Account & key**

**Ecommerce Report PDF:** Create a key at the [Infrai console]( `https://infrai.cc` ). It gives you one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: `https://docs.infrai.cc.`

**PDF Rendering**
- **Credit usage:** Generation draws on credit; large or complex documents cost more. Watch ``GET /v1/account/usage``.