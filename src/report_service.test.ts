import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, ReportRequest } from "./report_service.ts";

test("monthly report keeps fulfillment state and computes gross total", () => {
  const input = ReportRequest.parse({ period: "2026-08", orders: [{ id: "o-1", customer: "Lin", total: 10, status: "packed" }, { id: "o-2", customer: "Jo", total: 4.25, status: "paid" }] });
  const markdown = renderMarkdown(input);
  assert.match(markdown, /\*\*Gross total:\*\* 14\.25/);
  assert.match(markdown, /\| o-1 \| Lin \| packed \|/);
});
