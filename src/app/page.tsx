"use client";

import { useMemo, useRef, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

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

  // Conversation state
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Ask Metalhead about PizzaDAO Crews"
    }
  ]);

  // Latest retrieval artifacts (for the most recent assistant response)
  const [citations, setCitations] = useState<Citation[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [showEvidence, setShowEvidence] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  const canAsk = useMemo(
    () => question.trim().length > 0 && !loading,
    [question, loading]
  );

  async function ask() {
    const q = question.trim();
    if (!q || loading) return;

    setLoading(true);
    setQuestion("");

    // Clear artifacts for new turn
    setCitations([]);
    setEvidence([]);
    setShowEvidence(false);

    // Append user message immediately (optimistic UI)
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: q }];
    setMessages(nextMessages);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // NEW: send conversation
        body: JSON.stringify({ messages: nextMessages, topK: 35 })
      });

      const json = await res.json();

      const answer =
        typeof json.answer === "string" && json.answer.trim()
          ? json.answer.trim()
          : "I didn’t get an answer back (empty response).";

      setMessages((prev) => [...prev, { role: "assistant", content: answer }]);

      setCitations(Array.isArray(json.citations) ? json.citations : []);
      setEvidence(Array.isArray(json.evidence) ? json.evidence : []);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Request failed: ${String(e?.message || e)}`
        }
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }

  const latestAssistantAnswer = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].content;
    }
    return "";
  }, [messages]);

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

        {/* Conversation Window */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl overflow-hidden">
          <div className="max-h-[46vh] overflow-y-auto p-4 space-y-4">
            {messages.map((m, idx) => (
              <div
                key={idx}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={[
                    "max-w-[90%] rounded-2xl px-4 py-3 whitespace-pre-wrap leading-relaxed",
                    m.role === "user"
                      ? "bg-white text-black font-medium"
                      : "bg-zinc-900 border border-zinc-800 text-white"
                  ].join(" ")}
                >
                  {m.content}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input Row */}
          <div className="border-t border-zinc-800 p-3 bg-zinc-950">
            <div className="flex gap-2">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask Metalhead about PizzaDAO Crews"
                className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-3 outline-none focus:ring-2 focus:ring-zinc-700 transition-all"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canAsk) ask();
                }}
              />
              <button
                onClick={ask}
                disabled={!canAsk}
                className="rounded-lg bg-white text-black px-6 py-2 font-semibold hover:bg-zinc-200 disabled:opacity-50 transition-colors"
              >
                {loading ? "Searching…" : "Ask"}
              </button>
            </div>
          </div>
        </div>

        {/* Latest Answer Actions */}
        {latestAssistantAnswer && (
          <div className="flex gap-4">
            <button
              className="text-sm font-medium text-zinc-400 hover:text-white transition-colors"
              onClick={() => navigator.clipboard.writeText(latestAssistantAnswer)}
            >
              Copy latest answer
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
        )}

        {/* Sources */}
        {citations.length > 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-sm font-semibold mb-3 text-zinc-400 uppercase tracking-wider">
              Sources
            </div>
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

        {/* Evidence */}
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
