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
You are a precise analyst answering questions using ONLY the provided Sources from Google Sheets.

Rules:
- Treat Sources as authoritative. Do not invent values, names, roles, emails, IDs, or dates.
- Many Sources contain tables. Use headers to interpret rows correctly.
- Prefer exact values as written (names, emails, roles, IDs, dates).
- If the answer is not in the Sources, say what’s missing and suggest what to search for.
- Always cite with [#] after the sentence/claim (e.g., ... [2] or ... [1,3]).
- Prefer a short direct answer, then bullet details if helpful.

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

function keywords(q: string) {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter(
      (t) =>
        t.length >= 3 &&
        !["pizza", "pizzadao", "crew", "sheets"].includes(t)
    );
}

// Build a concise “evidence snippet” emphasizing table headers + matching lines
function makeSnippet(text: string, q: string, maxChars = 1100) {
  const lines = text.split("\n");
  const keys = new Set(keywords(q));

  // Header-ish: first lines + any table-like lines
  const headerish = lines
    .slice(0, 12)
    .filter(
      (l) => l.includes("|") || l.toLowerCase().includes("headers")
    );

  const picked: string[] = [];
  const add = (l: string) => {
    if (!l) return;
    if (picked.length && picked[picked.length - 1] === l) return;
    picked.push(l);
  };

  for (const l of headerish) add(l);

  // Include matching lines with neighborhood context
  const maxMatchBlocks = 18;
  let blocks = 0;
  for (let i = 0; i < lines.length && blocks < maxMatchBlocks; i++) {
    const lo = lines[i].toLowerCase();
    let hit = false;
    for (const k of keys) {
      if (lo.includes(k)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;

    add(lines[Math.max(0, i - 1)]);
    add(lines[i]);
    add(lines[Math.min(lines.length - 1, i + 1)]);
    blocks++;
  }

  // Fallback: if nothing matched, keep the first chunk portion
  let snippet = picked.filter(Boolean).join("\n").trim();
  if (!snippet) snippet = lines.slice(0, 30).join("\n").trim();

  if (snippet.length > maxChars) snippet = snippet.slice(0, maxChars) + "…";
  return snippet;
}

// Cheap rerank: overlap between query keywords and chunk text (+ similarity prior)
function rerankScore(chunkText: string, q: string, similarity: number) {
  const keys = keywords(q);
  if (keys.length === 0) return similarity;

  const lo = chunkText.toLowerCase();
  let hits = 0;
  for (const k of keys) if (lo.includes(k)) hits++;

  return similarity + Math.min(0.25, hits * 0.03);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as AskBody;

    const messages = coerceMessages(body);
    const lastUser =
      [...messages].reverse().find((m) => m.role === "user")?.content?.trim() ||
      "";

    if (!lastUser) {
      return NextResponse.json({ error: "Missing question" }, { status: 400 });
    }

    // Retrieval tuning
    const requestedTopK = Math.min(Math.max(body.topK ?? 35, 5), 120);

    // We retrieve wide, then narrow for the LLM
    const candidateK = Math.min(Math.max(requestedTopK * 3, 40), 120);
    const ANSWER_K = Math.min(Math.max(Math.floor((body.topK ?? 12) / 2), 8), 20); // sources passed to the model

    const retrievalQuery = buildRetrievalQuery(messages, lastUser);

    // 1) Embed BOTH raw question and retrieval query, then union results
    const [embQ, embR] = await Promise.all([
      openai.embeddings.create({ model: EMBED_MODEL, input: lastUser }),
      openai.embeddings.create({ model: EMBED_MODEL, input: retrievalQuery })
    ]);

    const qVec = embQ.data[0].embedding;
    const rVec = embR.data[0].embedding;

    const [m1, m2] = await Promise.all([
      supabase.rpc("match_chunks", {
        query_embedding: qVec,
        match_count: candidateK,
        filter_spreadsheet_id: body.filterSpreadsheetId ?? null
      }),
      supabase.rpc("match_chunks", {
        query_embedding: rVec,
        match_count: candidateK,
        filter_spreadsheet_id: body.filterSpreadsheetId ?? null
      })
    ]);

    if (m1.error) {
      return NextResponse.json(
        { error: "match_chunks failed", detail: m1.error.message },
        { status: 500 }
      );
    }
    if (m2.error) {
      return NextResponse.json(
        { error: "match_chunks failed", detail: m2.error.message },
        { status: 500 }
      );
    }

    const raw = ([...(m1.data ?? []), ...(m2.data ?? [])] as MatchChunkRow[]);

    if (raw.length === 0) {
      return NextResponse.json({
        answer:
          "I don’t see this information in the indexed sheets. (If you expect it exists, the sheet may not be indexed yet, or the relevant table wasn’t retrieved.)",
        citations: [],
        evidence: []
      });
    }

    // 2) Dedupe by (spreadsheet_id, sheet_name, a1_range) and keep best similarity
    const byKey = new Map<string, MatchChunkRow>();
    for (const c of raw) {
      const key = `${c.spreadsheet_id}|${c.sheet_name}|${c.a1_range}`;
      const prev = byKey.get(key);
      if (!prev || (c.similarity ?? 0) > (prev.similarity ?? 0)) byKey.set(key, c);
    }

    let chunksAll = Array.from(byKey.values());

    // 3) Cheap rerank
    chunksAll.sort((a, b) => {
      const sa = rerankScore(a.text, lastUser, a.similarity);
      const sb = rerankScore(b.text, lastUser, b.similarity);
      return sb - sa;
    });

    const top = chunksAll.slice(0, ANSWER_K);

    if (top.length === 0) {
      return NextResponse.json({
        answer:
          "I don’t see this information in the indexed sheets. (If you expect it exists, the relevant table wasn’t retrieved.)",
        citations: [],
        evidence: []
      });
    }

    // Build sources using snippets (NOT full text)
    const sources = top.map((c, i) => {
      const snippet = makeSnippet(c.text, lastUser, 1200);
      return [
        `Source #${i + 1}`,
        `Spreadsheet: ${c.spreadsheet_title ?? c.spreadsheet_id}`,
        `SpreadsheetId: ${c.spreadsheet_id}`,
        `Tab: ${c.sheet_name}`,
        `Range: ${c.a1_range}`,
        `Content:\n${snippet}`
      ].join("\n");
    });

    // Only include a small amount of history in the model prompt to control cost
    const modelHistory = messages.slice(-8).map((m) => ({
      role: m.role,
      content: m.content
    }));

    // 4) Answer grounded in sources
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },

        // Conversation context (NOT authoritative facts; facts must come from Sources)
        ...modelHistory,

        // Sources as final message so the model treats them as evidence
        {
          role: "user",
          content: `Use the Sources below to answer the latest user question.\n\nSources:\n\n${sources.join(
            "\n\n---\n\n"
          )}`
        }
      ]
    });

    const answer = completion.choices[0]?.message?.content?.trim() || "";

    // 5) Citations + evidence built from TOP (what the model saw)
    const citations = top.map((c) => {
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

    const evidence = top.map((c, i) => ({
      source: i + 1,
      spreadsheet_id: c.spreadsheet_id,
      sheet_name: c.sheet_name,
      a1_range: c.a1_range,
      preview: makeSnippet(c.text, lastUser, 900)
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
