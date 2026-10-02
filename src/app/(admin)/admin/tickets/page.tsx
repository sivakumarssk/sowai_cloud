"use client";

import { useState, useEffect, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { showToast } from "@/components/ui/Toast";

interface Ticket {
  id: string;
  subject: string;
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED";
  priority: "LOW" | "MEDIUM" | "HIGH";
  messages: { role: string; message: string; createdAt: string }[];
  createdAt: string;
  user: { name: string; email: string };
}

const statusColors = {
  OPEN: "bg-blue-900/40 text-blue-400 border-blue-800",
  IN_PROGRESS: "bg-amber-900/40 text-amber-400 border-amber-800",
  RESOLVED: "bg-green-900/40 text-green-400 border-green-800",
};

const priorityColors = {
  LOW: "text-gray-400",
  MEDIUM: "text-amber-400",
  HIGH: "text-red-400",
};

export default function AdminTicketsPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [reply, setReply] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    fetch("/api/admin/tickets")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setTickets(d.data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function updateStatus(ticketId: string, status: string) {
    startTransition(async () => {
      const res = await fetch(`/api/admin/tickets/${ticketId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (res.ok) {
        setTickets((t) => t.map((tk) => (tk.id === ticketId ? data.data : tk)));
        if (selected?.id === ticketId) setSelected(data.data);
        showToast("Status updated", "success");
      }
    });
  }

  function sendAdminReply(ticketId: string) {
    if (!reply.trim()) return;
    startTransition(async () => {
      const res = await fetch(`/api/admin/tickets/${ticketId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: reply }),
      });
      const data = await res.json();
      if (res.ok) {
        setSelected(data.data);
        setTickets((t) => t.map((tk) => (tk.id === ticketId ? data.data : tk)));
        setReply("");
      } else {
        showToast(data.error || "Failed", "error");
      }
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="animate-spin w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Support Tickets</h1>
        <p className="text-gray-500 text-sm mt-1">Manage and respond to client support tickets</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Ticket list */}
        <div className="flex flex-col gap-3">
          {tickets.map((ticket) => (
            <button
              key={ticket.id}
              onClick={() => setSelected(ticket)}
              className={`bg-[#111827] border rounded-xl p-4 text-left transition-all w-full ${
                selected?.id === ticket.id ? "border-purple-600" : "border-[#1F2937] hover:border-purple-700/50"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium truncate">{ticket.subject}</p>
                  <p className="text-gray-500 text-xs mt-0.5">{ticket.user.name} · {ticket.user.email}</p>
                  <p className="text-gray-600 text-xs mt-1">{new Date(ticket.createdAt).toLocaleDateString("en-IN")}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-md border ${statusColors[ticket.status]}`}>
                    {ticket.status.replace("_", " ")}
                  </span>
                  <span className={`text-xs font-medium ${priorityColors[ticket.priority]}`}>
                    {ticket.priority}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Ticket thread */}
        {selected ? (
          <div className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-[#1F2937]">
              <h3 className="text-white font-medium">{selected.subject}</h3>
              <p className="text-gray-500 text-xs mt-0.5">{selected.user.name} · {selected.user.email}</p>
              <div className="flex gap-2 mt-3">
                {["OPEN", "IN_PROGRESS", "RESOLVED"].map((s) => (
                  <button
                    key={s}
                    onClick={() => updateStatus(selected.id, s)}
                    className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                      selected.status === s
                        ? statusColors[s as keyof typeof statusColors]
                        : "border-[#374151] text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    {s.replace("_", " ")}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 p-4 flex flex-col gap-3 max-h-[400px] overflow-y-auto">
              {selected.messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "ADMIN" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm ${
                      msg.role === "ADMIN"
                        ? "bg-purple-900/60 text-purple-100 rounded-br-sm"
                        : "bg-[#1F2937] text-gray-200 rounded-bl-sm"
                    }`}
                  >
                    <p className="text-xs opacity-60 mb-1">{msg.role === "ADMIN" ? "Support" : selected.user.name}</p>
                    <p>{msg.message}</p>
                  </div>
                </div>
              ))}
            </div>

            {selected.status !== "RESOLVED" && (
              <div className="px-4 py-3 border-t border-[#1F2937] flex gap-2">
                <input
                  type="text"
                  placeholder="Type reply..."
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendAdminReply(selected.id);
                    }
                  }}
                  className="flex-1 px-3 py-2 rounded-lg bg-[#0A0F1E] border border-[#374151] text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-purple-600"
                />
                <Button size="sm" loading={isPending} onClick={() => sendAdminReply(selected.id)}>
                  Send
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-12 flex items-center justify-center">
            <p className="text-gray-500 text-sm">Select a ticket to view</p>
          </div>
        )}
      </div>
    </div>
  );
}
