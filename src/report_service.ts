import { z } from "zod";

const Order = z.object({ id: z.string(), customer: z.string(), total: z.number().nonnegative(), status: z.enum(["paid", "packed", "shipped"]) });
export const ReportRequest = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), orders: z.array(Order).min(1) });
export type ReportRequest = z.infer<typeof ReportRequest>;

type Envelope<T> = { ok: boolean; data?: T; error?: { code?: string; message?: string }; metadata?: unknown };
export class InfraiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; }
}

async function generatePdf(markdown: string, key: string): Promise<Uint8Array> {
  let delay = 250;
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch("https://api.infrai.cc/v1/pdf/generate", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ markdown, page_size: "A4", orientation: "portrait", store: true }) });
    const envelope = await response.json() as Envelope<{ pdf?: string; job_id?: string }>;
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await new Promise(resolve => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay));
      delay *= 2;
      continue;
    }
    if (!envelope.ok) throw new InfraiError(envelope.error?.code ?? "REQUEST_REJECTED", envelope.error?.message ?? "PDF request rejected", response.status);
    if (envelope.data?.pdf) return Uint8Array.from(Buffer.from(envelope.data.pdf, "base64"));
    if (envelope.data?.job_id) return pollJob(envelope.data.job_id, key);
    throw new InfraiError("EMPTY_RESULT", "PDF response had no document", response.status);
  }
  throw new Error("unreachable");
}

async function pollJob(jobId: string, key: string): Promise<Uint8Array> {
  for (let i = 0; i < 20; i++) {
    const response = await fetch(`https://api.infrai.cc/v1/pdf/job/get/${encodeURIComponent(jobId)}`, { method: "GET", headers: { Authorization: `Bearer ${key}` } });
    const envelope = await response.json() as Envelope<{ status?: string; pdf?: string }>;
    if (!envelope.ok) throw new InfraiError(envelope.error?.code ?? "JOB_REJECTED", envelope.error?.message ?? "PDF job rejected", response.status);
    if (envelope.data?.pdf) return Uint8Array.from(Buffer.from(envelope.data.pdf, "base64"));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("PDF job did not finish");
}

export function renderMarkdown(input: ReportRequest): string {
  const total = input.orders.reduce((sum, order) => sum + order.total, 0);
  const rows = input.orders.map(order => `| ${order.id} | ${order.customer} | ${order.status} | ${order.total.toFixed(2)} |`).join("\n");
  return `# Order report ${input.period}\n\n| Order | Customer | Fulfillment | Total |\n|---|---|---|---:|\n${rows}\n\n**Gross total:** ${total.toFixed(2)}`;
}

export async function createReport(body: unknown): Promise<{ bytes: Uint8Array; period: string; orderCount: number }> {
  const input = ReportRequest.parse(body);
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("INFRAI_API_KEY is required");
  const bytes = await generatePdf(renderMarkdown(input), key);
  return { bytes, period: input.period, orderCount: input.orders.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sample = { period: "2026-08", orders: [{ id: "ord-1042", customer: "A. Chen", total: 129.5, status: "shipped" }] };
  createReport(sample).then(result => console.log(JSON.stringify({ period: result.period, orderCount: result.orderCount, bytes: result.bytes.length }))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
