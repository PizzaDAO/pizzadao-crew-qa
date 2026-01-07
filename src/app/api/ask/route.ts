// src/app/api/ask/route.ts
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AskBody = {
  question: string;
  topK?: number;
  filterSpreadsheetId?: string | null;
};

type MatchChunkRow = {
  id: string;
  spreadsheet_id: string;
  sheet_name: string;
  a1_range: string;
  text: string;
  metadata: any;
  similarity: number;
};

type SpreadsheetRow = {
  spreadsheet_id: string;
  title: string | null;
  url: string | null;
  crawl_status: string | null;
  last_indexed_at: string | null;
  drive_modified_time: string | null;
  error: string | null;
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini";

function sheetUrl(spreadsheetId: string, gid?: number | null) {
  return gid
    ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}`
    : `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

// Simple “retrieval rewrite” (no extra LLM call)
function toRetrievalQuery(q: string) {
  // Add a little context so vague questions retrieve better.
  return `Answer questions about PizzaDAO crew sheets. Query: ${q}.
Look for names, roles, status, meeting times, leads, crew membership lists, and roster tables.`;
}

// Detect index/coverage questions (don’t route through semantic retrieval)
function isIndexQuestion(q: string) {
  return /what sheets|which sheets|how many sheets|memory|indexed|index status|coverage|crawl_status|pending|errors|stuck/i.test(
    q
  );
}

function summarizeIndex(rows: SpreadsheetRow[]) {
  const total = rows.length;
  const byStatus = new Map<string, number>();
  for (const r of rows) {
    const s = (r.crawl_status || "unknown").toLowerCase();
    byStatus.set(s, (byStatus.get(s) || 0) + 1);
  }

  const statusParts = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`);

  const indexed = (byStatus.get("indexed") || 0) + (byStatus.get("skipped") || 0); // “skipped” means known+checked
  const pending = byStatus.get("pending") || 0;
  const inProgress = byStatus.get("in_progress") || 0;
  const errored = byStatus.get("error") || 0;

  const answerLines = [
    `Index status: ${total} spreadsheets known.`,
    statusParts.length ? `Status counts — ${statusParts.join(", ")}.` : "",
    `Indexed/checked: ${indexed}. Pending: ${pending}. In progress: ${inProgress}. Errors: ${errored}.`
  ].filter(Boolean);

  return answerLines.join("\n");
}

function dedupeCitations(chunks: MatchChunkRow[]) {
  return Array.from(
    new Map(
      chunks.map((c) => [`${c.spreadsheet_id}|${c.sheet_name}|${c.a1_range}`, c])
    ).values()
  ).map((c) => {
    const gid = c.metadata?.gid ?? null;
    return {
      spreadsheet_id: c.spreadsheet_id,
      url: sheetUrl(c.spreadsheet_id, gid),
      sheet_name: c.sheet_name,
      a1_range: c.a1_range,
      similarity: c.similarity
    };
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AskBody;
    const question = (body.question || "").trim();

    // allow larger recall
    const topK = Math.min(Math.max(body.topK ?? 25, 5), 50);

    if (!question) {
      return NextResponse.json({ error: "Missing question" }, { status: 400 });
    }

    // --- ✅ Introspection path: answer from spreadsheets table, not chunks ---
    if (isIndexQuestion(question)) {
      const q = supabase
        .from("spreadsheets")
        .select(
          "spreadsheet_id,title,url,crawl_status,last_indexed_at,drive_modified_time,error"
        )
        .order("first_seen_at", { ascending: true });

      const { data, error } = await q;
      if (error) {
        return NextResponse.json(
          { error: "Failed to read index metadata", detail: error.message },
          { status: 500 }
        );
      }

      const rows = (data || []) as SpreadsheetRow[];

      // If they filtered to one spreadsheet, still show accurate “what do we have for that id”
      const filtered =
        body.filterSpreadsheetId != null
          ? rows.filter((r) => r.spreadsheet_id === body.filterSpreadsheetId)
          : rows;

      const answer = summarizeIndex(filtered);

      const evidence = filtered.slice(0, 50).map((r, i) => ({
        source: i + 1,
        spreadsheet_id: r.spreadsheet_id,
        sheet_name: r.title ?? "(unknown title)",
        a1_range: "",
        preview: `status=${r.crawl_status ?? "unknown"} last_indexed_at=${
          r.last_indexed_at ?? "NULL"
        } drive_modified_time=${r.drive_modified_time ?? "NULL"}${
          r.error ? ` error=${r.error}` : ""
        }`
      }));

      return NextResponse.json({
        answer,
        citations: [],
        evidence
      });
    }

    // --- ✅ Normal semantic RAG path ---
    const retrievalQuery = toRetrievalQuery(question);

    // 1) Embed the retrieval query (NOT just the raw question)
    const emb = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: retrievalQuery
    });
    const queryEmbedding = emb.data[0].embedding;

    // 2) Retrieve relevant chunks
    const { data: matches, error } = await supabase.rpc("match_chunks", {
      query_embedding: queryEmbedding,
      match_count: topK,
      filter_spreadsheet_id: body.filterSpreadsheetId ?? null
    });

    if (error) {
      return NextResponse.json(
        { error: "match_chunks failed", detail: error.message },
        { status: 500 }
      );
    }

    const chunks = (matches || []) as MatchChunkRow[];

    if (chunks.length === 0) {
      return NextResponse.json({
        answer:
          "I couldn’t find anything relevant in the indexed sheets yet. (If you expect data exists, the index may not include the right sheets, or match_chunks may be filtering too aggressively.)",
        citations: [],
        evidence: []
      });
    }

    // 3) Build grounded prompt
    const sources = chunks.map((c, i) => {
      return [
        `Source #${i + 1}`,
        `Spreadsheet: ${c.spreadsheet_id}`,
        `Tab: ${c.sheet_name}`,
        `Range: ${c.a1_range}`,
        `Content:\n${c.text}`
      ].join("\n");
    });

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "You answer questions using ONLY the provided Sources from Google Sheets. " +
            "If the sources don't contain the answer, say so clearly. " +
            "Cite sources like [1] or [2,3] when making claims. " +
            "Never claim to know how many sheets are indexed unless sources explicitly state that."
        },
        {
          role: "user",
          content: `Question: ${question}\n\nSources:\n\n${sources.join(
            "\n\n---\n\n"
          )}`
        }
      ]
    });

    const answer = completion.choices[0]?.message?.content?.trim() || "";

    // 4) Citations + evidence
    const citations = dedupeCitations(chunks);

    const evidence = chunks.map((c, i) => ({
      source: i + 1,
      spreadsheet_id: c.spreadsheet_id,
      sheet_name: c.sheet_name,
      a1_range: c.a1_range,
      preview: c.text.slice(0, 800)
    }));

    return NextResponse.json({ answer, citations, evidence });
  } catch (e: any) {
    return NextResponse.json(
      { error: "Unhandled error", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
