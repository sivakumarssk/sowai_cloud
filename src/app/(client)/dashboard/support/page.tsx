"use client";

import { useState, useEffect, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { showToast } from "@/components/ui/Toast";

interface Ticket {
  id: string;
  subject: string;
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED";
  priority: "LOW" | "MEDIUM" | "HIGH";
  messages: { role: string; message: string; createdAt: string }[];
  createdAt: string;
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

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [newMessage, setNewMessage] = useState("");
  const [form, setForm] = useState({ subject: "", message: "", priority: "MEDIUM" });
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    fetch("/api/tickets")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setTickets(d.data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function createTicket(e: React.FormEvent) {
    e.preventDefault();
    if (!form.subject || !form.message) return;

    startTransition(async () => {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok) {
        setTickets((t) => [data.data, ...t]);
        setShowForm(false);
        setForm({ subject: "", message: "", priority: "MEDIUM" });
        showToast("Ticket created successfully!", "success");
      } else {
        showToast(data.error || "Failed to create ticket", "error");
      }
    });
  }

  function sendReply(ticketId: string) {
    if (!newMessage.trim()) return;

    startTransition(async () => {
      const res = await fetch(`/api/tickets/${ticketId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: newMessage }),
      });
      const data = await res.json();
      if (res.ok) {
        setSelectedTicket(data.data);
        setTickets((t) => t.map((tk) => (tk.id === ticketId ? data.data : tk)));
        setNewMessage("");
      } else {
        showToast(data.error || "Failed to send reply", "error");
      }
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="animate-spin w-8 h-8 border-2 border-[#1B4FE8] border-t-transparent rounded-full" />
      </div>
    );
  }

  if (selectedTicket) {
    return (
      <div>
        <button
          onClick={() => setSelectedTicket(null)}
          className="flex items-center gap-2 text-gray-400 hover:text-white text-sm mb-6 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to tickets
        </button>

        <div className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-[#1F2937] flex items-start justify-between gap-4">
            <div>
              <h2 className="text-white font-semibold">{selectedTicket.subject}</h2>
              <p className="text-gray-500 text-xs mt-1">
                Opened {new Date(selectedTicket.createdAt).toLocaleDateString("en-IN")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-0.5 rounded-md border font-medium ${priorityColors[selectedTicket.priority]}`}>
                {selectedTicket.priority}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-md border font-medium ${statusColors[selectedTicket.status]}`}>
                {selectedTicket.status.replace("_", " ")}
              </span>
            </div>
          </div>

          <div className="p-6 flex flex-col gap-4 min-h-[300px] max-h-[500px] overflow-y-auto">
            {selectedTicket.messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "CLIENT" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[70%] rounded-2xl px-4 py-3 text-sm ${
                    msg.role === "CLIENT"
                      ? "bg-[#1B4FE8] text-white rounded-br-sm"
                      : "bg-[#1F2937] text-gray-200 rounded-bl-sm"
                  }`}
                >
                  <p className="text-xs opacity-60 mb-1">{msg.role === "CLIENT" ? "You" : "Support"}</p>
                  <p>{msg.message}</p>
                </div>
              </div>
            ))}
          </div>

          {selectedTicket.status !== "RESOLVED" && (
            <div className="px-6 py-4 border-t border-[#1F2937] flex gap-3">
              <input
                type="text"
                placeholder="Type your message..."
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendReply(selectedTicket.id);
                  }
                }}
                className="flex-1 px-4 py-2.5 rounded-lg bg-[#0A0F1E] border border-[#374151] text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-[#1B4FE8]"
              />
              <Button onClick={() => sendReply(selectedTicket.id)} loading={isPending} size="md">
                Send
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Support</h1>
          <p className="text-gray-500 text-sm mt-1">Create and manage support tickets</p>
        </div>
        <Button onClick={() => setShowForm(true)}>New Ticket</Button>
      </div>

      {showForm && (
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6 mb-6">
          <h2 className="text-white font-semibold mb-4">Create Support Ticket</h2>
          <form onSubmit={createTicket} className="flex flex-col gap-4">
            <Input
              label="Subject"
              placeholder="Brief description of the issue"
              value={form.subject}
              onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
            />
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-gray-300">Priority</label>
              <select
                value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                className="w-full px-4 py-2.5 rounded-lg bg-[#0A0F1E] border border-[#374151] text-white text-sm focus:outline-none focus:ring-2 focus:ring-[#1B4FE8]"
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-gray-300">Message</label>
              <textarea
                rows={4}
                placeholder="Describe your issue in detail..."
                value={form.message}
                onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
                className="w-full px-4 py-2.5 rounded-lg bg-[#0A0F1E] border border-[#374151] text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-[#1B4FE8] resize-none"
              />
            </div>
            <div className="flex gap-3">
              <Button type="submit" loading={isPending}>Create Ticket</Button>
              <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </form>
        </div>
      )}

      {tickets.length === 0 ? (
        <div className="bg-[#111827] border border-[#1F2937] rounded-2xl p-16 text-center">
          <p className="text-gray-500 text-sm mb-4">No support tickets yet</p>
          <Button onClick={() => setShowForm(true)}>Create First Ticket</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {tickets.map((ticket) => (
            <button
              key={ticket.id}
              onClick={() => setSelectedTicket(ticket)}
              className="bg-[#111827] border border-[#1F2937] rounded-xl p-5 text-left hover:border-[#1B4FE8]/50 transition-all w-full"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-white font-medium truncate">{ticket.subject}</p>
                  <p className="text-gray-500 text-xs mt-1">
                    {new Date(ticket.createdAt).toLocaleDateString("en-IN")} •{" "}
                    {ticket.messages.length} message{ticket.messages.length !== 1 ? "s" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs font-medium ${priorityColors[ticket.priority]}`}>
                    {ticket.priority}
                  </span>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-md border ${statusColors[ticket.status]}`}>
                    {ticket.status.replace("_", " ")}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
