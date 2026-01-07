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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!
});

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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AskBody;
    const question = (body.question || "").trim();
    const topK = Math.min(Math.max(body.topK ?? 10, 3), 20);

    if (!question) {
      return NextResponse.json({ error: "Missing question" }, { status: 400 });
    }

    // 1) Embed the question
    const emb = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: question
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
          "I couldn’t find anything relevant in the indexed sheets yet. This usually means the indexer hasn’t crawled the sheet that contains the answer, or the info isn’t present in the linked-sheet graph.",
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
            "Cite sources like [1] or [2,3] when making claims."
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
    const citations = chunks.map((c) => {
      const gid = c.metadata?.gid ?? null;
      return {
        spreadsheet_id: c.spreadsheet_id,
        url: sheetUrl(c.spreadsheet_id, gid),
        sheet_name: c.sheet_name,
        a1_range: c.a1_range,
        similarity: c.similarity
      };
    });

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
