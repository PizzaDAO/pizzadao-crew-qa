import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type AskBody = {
  // New: chat-based input
  messages?: ChatMessage[];

  // Back-compat: still allow single question
  question?: string;

  topK?: number;
  filterSpreadsheetId?: string | null;
};

type MatchChunkRow = {
  id: string;
  spreadsheet_id: string;
  spreadsheet_title: string | null;
  sheet_name: string;
  a1_range: string;
  text: string;
  metadata: any;
  similarity: number;
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini";

const SYSTEM_PROMPT = `
You are a question-answering assistant over Google Sheets.

Rules:
- Use ONLY the provided Sources for factual claims.
- Treat Sources as authoritative.
- Many tabs contain multiple tables; pay attention to Headers and Row lines.
- Prefer exact values as written (names, emails, roles, IDs, dates).
- If the Sources don't contain the answer, say so clearly.
- Cite sources like [1] or [2,3] after each claim.

If the answer cannot be determined from the Sources, respond:
"I don’t see this information in the indexed sheets."
`.trim();

function sheetUrl(spreadsheetId: string, gid?: number | null) {
  return gid
    ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}`
    : `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

// Build an embedding query using recent conversation context (cheap “rewrite”)
function buildRetrievalQuery(messages: ChatMessage[], fallbackQuestion: string) {
  const lastUser =
    [...messages].reverse().find((m) => m.role === "user")?.content?.trim() || "";
  const recent = messages
    .slice(-8) // keep it short for cost
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const q = (lastUser || fallbackQuestion).trim();

  return `
You are retrieving information from PizzaDAO crew spreadsheets and related linked sheets.
Focus on rosters, roles, statuses, meeting times, leads, cities, contacts, and IDs.

Recent conversation:
${recent}

Current question:
${q}
`.trim();
}

function coerceMessages(body: AskBody): ChatMessage[] {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const cleaned: ChatMessage[] = [];

  for (const m of msgs) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = String(m.content ?? "").trim();
    if (!content) continue;
    cleaned.push({ role: m.role, content });
  }

  // Back-compat: if caller still sends {question}, treat it as last user message
  const q = String(body.question ?? "").trim();
  if (cleaned.length === 0 && q) cleaned.push({ role: "user", content: q });

  // Ensure we have at least one user message
  if (cleaned.length === 0 || cleaned.every((m) => m.role !== "user")) {
    if (q) cleaned.push({ role: "user", content: q });
  }

  return cleaned;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AskBody;

    const messages = coerceMessages(body);
    const lastUser =
      [...messages].reverse().find((m) => m.role === "user")?.content?.trim() || "";

    if (!lastUser) {
      return NextResponse.json({ error: "Missing question" }, { status: 400 });
    }

    // Retrieval tuning
    const topK = Math.min(Math.max(body.topK ?? 35, 5), 60);
    const ANSWER_K = Math.min(12, topK); // pass fewer sources to the LLM

    const retrievalQuery = buildRetrievalQuery(messages, lastUser);

    // 1) Embed retrieval query
    const emb = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: retrievalQuery
    });
    const queryEmbedding = emb.data[0].embedding;

    // 2) Retrieve chunks
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

    const chunksAll = (matches || []) as MatchChunkRow[];

    if (chunksAll.length === 0) {
      return NextResponse.json({
        answer:
          "I don’t see this information in the indexed sheets. (If you expect it exists, the sheet may not be indexed yet, or the relevant table wasn’t retrieved.)",
        citations: [],
        evidence: []
      });
    }

    // Dedup + keep top ANSWER_K for the model
    const chunks = Array.from(
      new Map(
        chunksAll.map((c) => [`${c.spreadsheet_id}|${c.sheet_name}|${c.a1_range}`, c])
      ).values()
    ).slice(0, ANSWER_K);

    const sources = chunks.map((c, i) => {
      return [
        `Source #${i + 1}`,
        `Spreadsheet: ${c.spreadsheet_id}`,
        `Tab: ${c.sheet_name}`,
        `Range: ${c.a1_range}`,
        `Content:\n${c.text}`
      ].join("\n");
    });

    // Only include a small amount of history in the model prompt to control cost
    const modelHistory = messages.slice(-8).map((m) => ({
      role: m.role,
      content: m.content
    }));

    // 3) Answer grounded in sources
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },

        // Conversation context (NOT authoritative facts; facts must come from Sources)
        ...modelHistory,

        // Sources are provided as the final user message so the model treats them as evidence
        {
          role: "user",
          content: `Use the Sources below to answer the latest user question.\n\nSources:\n\n${sources.join(
            "\n\n---\n\n"
          )}`
        }
      ]
    });

    const answer = completion.choices[0]?.message?.content?.trim() || "";

    // 4) Citations + evidence
  const citations = Array.from(
  new Map(
    chunks.map(c => [
      `${c.spreadsheet_id}|${c.sheet_name}|${c.a1_range}`,
      c
    ])
  ).values()
).map(c => {
  const gid = c.metadata?.gid ?? null;
  return {
    spreadsheet_id: c.spreadsheet_id,
    spreadsheet_title: c.spreadsheet_title ?? c.spreadsheet_id,
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
      preview: c.text.slice(0, 900)
    }));

    return NextResponse.json({
      answer,
      citations,
      evidence
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: "Unhandled error", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
