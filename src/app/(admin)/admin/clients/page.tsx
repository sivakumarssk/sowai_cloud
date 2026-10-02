"use client";

import { useState, useEffect, useTransition } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { showToast } from "@/components/ui/Toast";

interface Client {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string | null;
  isVerified: boolean;
  createdAt: string;
  _count: { services: number; payments: number };
}

export default function AdminClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    fetch("/api/admin/clients")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setClients(d.data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = clients.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.email.toLowerCase().includes(search.toLowerCase()) ||
      (c.company || "").toLowerCase().includes(search.toLowerCase())
  );

  function toggleSuspend(clientId: string) {
    startTransition(async () => {
      const res = await fetch(`/api/admin/clients/${clientId}/toggle`, { method: "PATCH" });
      const data = await res.json();
      if (res.ok) {
        showToast("Client status updated", "success");
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
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Clients</h1>
          <p className="text-gray-500 text-sm mt-1">{clients.length} total clients</p>
        </div>
      </div>

      <div className="mb-4 max-w-sm">
        <Input
          placeholder="Search by name, email, or company..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#1F2937]">
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Client</th>
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Contact</th>
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Services</th>
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Joined</th>
                <th className="text-right px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1F2937]">
              {filtered.map((client) => (
                <tr key={client.id} className="hover:bg-white/[0.02] transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#1B4FE8] to-[#0EA5E9] flex items-center justify-center text-white text-xs font-bold shrink-0">
                        {client.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-white text-sm font-medium">{client.name}</p>
                        {client.company && (
                          <p className="text-gray-500 text-xs">{client.company}</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <p className="text-gray-300 text-sm">{client.email}</p>
                    <p className="text-gray-500 text-xs">{client.phone}</p>
                  </td>
                  <td className="px-6 py-4">
                    <p className="text-white text-sm">{client._count.services} services</p>
                    <p className="text-gray-500 text-xs">{client._count.payments} payments</p>
                  </td>
                  <td className="px-6 py-4 text-gray-400 text-sm">
                    {new Date(client.createdAt).toLocaleDateString("en-IN")}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={isPending}
                      onClick={() => toggleSuspend(client.id)}
                      className="text-xs text-amber-400 hover:text-amber-300"
                    >
                      Manage
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
