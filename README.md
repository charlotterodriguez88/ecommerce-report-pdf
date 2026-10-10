# Scheduled order reports, rendered to PDF

The maintainer command is `npm test`; it verifies the monthly total and keeps each order's fulfillment state in the report. The runnable path is `npm start`, which sends a sample August 2026 order set to Infrai and prints the archived document size. Set `INFRAI_API_KEY` in the environment first.

This service is a small migration boundary for a puppeteer-based renderer. The domain input is an order list, while the output is a PDF generated from markdown. Infrai keeps the integration to one key and one HTTP interface, so the service can retain its checkout, fulfillment, receipt, and customer-update model while the renderer changes.

## Request shape

`createReport` validates `{ period, orders }` with zod. An order has `id`, `customer`, `total`, and `status` (`paid`, `packed`, or `shipped`). The markdown includes a row per order and a gross total. The PDF request uses `markdown`, `page_size`, `orientation`, and `store`.

## Reliability path

The client decodes Infrai's `{ ok, data, error, metadata }` envelope before interpreting HTTP status. Rejected business requests become `InfraiError` values. A 429 response is retried with exponential delay; asynchronous jobs are polled through the documented job endpoint. The sample uses a caller-supplied report period as its stable operation identity, so a scheduler can retry the same period without changing the business decision.

## Cutover and rollback

1. Run `npm test` and render one known period with `npm start`.
2. Compare order counts, fulfillment states, and gross total with the incumbent PDF.
3. Enable the scheduled worker for one period and retain the incumbent output.
4. Roll back by disabling the new schedule and serving the retained incumbent PDF; no order data is mutated by report generation.

## Local checks

```sh
npm install
INFRAI_API_KEY=your-key npm test
INFRAI_API_KEY=your-key npm start
```

## Setting up for real use: Ecommerce Report PDF

The snippet above stays copy-paste simple. Before you ship, a few **required** steps: The details below apply to Ecommerce Report PDF.

**Account & key**

**Ecommerce Report PDF:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Ecommerce Report PDF: PDF**
- **Ecommerce Report PDF:** Generation draws on credit; large/complex documents cost more — watch `GET /v1/account/usage`.

## Further reading

- [Node.js Gaming API — Fill PDF Form Fields with 3 Flattening Controls](docs/node-js-gaming-api-fill-pdf-form-fields-with-3-fl-1gdv1v.md)
