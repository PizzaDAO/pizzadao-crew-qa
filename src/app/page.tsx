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
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Header Section */}
        <div className="flex items-end justify-between border-b border-zinc-800 pb-4">
          <div>
            <h1 className="text-4xl font-bold tracking-tight text-white">
              Metalhead
            </h1>
            <p className="text-xl text-zinc-400 font-medium">PizzaDAO</p>
          </div>
          <a
            href="https://crew.pizzadao.xyz"
            target="_blank"
            rel="noreferrer"
            className="text-sm underline text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Crew Root
          </a>
        </div>

        {/* Branding Image */}
        <div className="flex justify-center py-4">
          <img 
            src="https://i.imgur.com/P85PEHz.png" 
            alt="Metalhead PizzaDAO" 
            className="w-full max-w-md rounded-lg shadow-2xl"
          />
        </div>

        {/* Search Bar */}
        <div className="flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask Metalhead about PizzaDAO"
            className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-3 outline-none focus:ring-2 focus:ring-zinc-700 transition-all"
            onKeyDown={(e) => {
              if (e.key === "Enter" && question.trim() && !loading) ask();
            }}
          />
          <button
            onClick={ask}
            disabled={!question.trim() || loading}
            className="rounded-lg bg-white text-black px-6 py-2 font-semibold hover:bg-zinc-200 disabled:opacity-50 transition-colors"
          >
            {loading ? "Searching…" : "Ask"}
          </button>
        </div>

        {/* Results Sections */}
        {answer && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-xl">
            <div className="whitespace-pre-wrap leading-relaxed text-lg">{answer}</div>
            <div className="mt-4 flex gap-4 border-t border-zinc-900 pt-4">
              <button
                className="text-sm font-medium text-zinc-400 hover:text-white transition-colors"
                onClick={() => navigator.clipboard.writeText(answer)}
              >
                Copy answer
              </button>
              {evidence.length > 0 && (
                <button
                  className="text-sm font-medium text-zinc-400 hover:text-white transition-colors"
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
            <div className="text-sm font-semibold mb-3 text-zinc-400 uppercase tracking-wider">Sources</div>
            <ul className="space-y-2 text-sm">
              {citations.slice(0, 10).map((c, idx) => (
                <li key={`${c.spreadsheet_id}-${idx}`} className="flex flex-col">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 hover:underline font-medium"
                  >
                    {c.spreadsheet_id}
                  </a>
                  <span className="text-zinc-500">
                    {c.sheet_name} • {c.a1_range}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {showEvidence && evidence.length > 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-sm font-semibold mb-4 text-zinc-400 uppercase tracking-wider">
              Evidence (retrieved text)
            </div>
            <div className="space-y-4">
              {evidence.map((e) => (
                <div key={e.source} className="text-sm">
                  <div className="text-zinc-400 mb-1">
                    <span className="font-bold">Source #{e.source}</span>
                    <span className="ml-2 opacity-70">
                      — {e.sheet_name} — {e.a1_range}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap text-zinc-300 bg-black/50 p-4 rounded-lg border border-zinc-800 font-mono text-xs">
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