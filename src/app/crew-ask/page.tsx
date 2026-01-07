"use client";

import { useState } from "react";

type Citation = {
  spreadsheet_id: string;
  url: string;
  sheet_name: string;
  a1_range: string;
  similarity: number;
};

type Evidence = {
  source: number;
  spreadsheet_id: string;
  sheet_name: string;
  a1_range: string;
  preview: string;
};

export default function CrewAskPage() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [showEvidence, setShowEvidence] = useState(false);

  async function ask() {
    setLoading(true);
    setAnswer("");
    setCitations([]);
    setEvidence([]);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, topK: 10 })
      });
      const json = await res.json();
      setAnswer(json.answer || "");
      setCitations(json.citations || []);
      setEvidence(json.evidence || []);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-black text-white p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">
            PizzaDAO Crew Sheets Q&amp;A
          </h1>
          <a
            href="https://crew.pizzadao.xyz"
            target="_blank"
            rel="noreferrer"
            className="text-sm underline text-zinc-300"
          >
            Crew Root
          </a>
        </div>

        <div className="flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask something about the linked crew sheets…"
            className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2 outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && question.trim() && !loading) ask();
            }}
          />
          <button
            onClick={ask}
            disabled={!question.trim() || loading}
            className="rounded-lg bg-white text-black px-4 py-2 disabled:opacity-50"
          >
            {loading ? "Searching…" : "Ask"}
          </button>
        </div>

        {answer && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="whitespace-pre-wrap leading-relaxed">{answer}</div>
            <div className="mt-3 flex gap-3">
              <button
                className="text-sm underline text-zinc-300"
                onClick={() => navigator.clipboard.writeText(answer)}
              >
                Copy answer
              </button>
              {evidence.length > 0 && (
                <button
                  className="text-sm underline text-zinc-300"
                  onClick={() => setShowEvidence((v) => !v)}
                >
                  {showEvidence ? "Hide evidence" : "Show evidence"}
                </button>
              )}
            </div>
          </div>
        )}

        {citations.length > 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-sm font-semibold mb-2">Sources</div>
            <ul className="space-y-2 text-sm">
              {citations.slice(0, 10).map((c, idx) => (
                <li key={`${c.spreadsheet_id}-${idx}`}>
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {c.spreadsheet_id}
                  </a>
                  <span className="text-zinc-400">
                    {" "}
                    — {c.sheet_name} — {c.a1_range}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {showEvidence && evidence.length > 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-sm font-semibold mb-2">
              Evidence (retrieved text)
            </div>
            <div className="space-y-4">
              {evidence.map((e) => (
                <div key={e.source} className="text-sm">
                  <div className="text-zinc-300">
                    <span className="font-semibold">Source #{e.source}</span>
                    <span className="text-zinc-500">
                      {" "}
                      — {e.sheet_name} — {e.a1_range}
                    </span>
                  </div>
                  <pre className="mt-2 whitespace-pre-wrap text-zinc-200 bg-black/30 p-3 rounded-lg border border-zinc-800">
                    {e.preview}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
