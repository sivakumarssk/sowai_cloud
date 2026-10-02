"use client";

import { useState, useEffect, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { showToast } from "@/components/ui/Toast";

interface ServiceRecord {
  id: string;
  status: "ACTIVE" | "SUSPENDED" | "CANCELLED" | "DELETED";
  serverIp: string | null;
  sshUsername: string | null;
  sshPassword: string | null;
  panelUrl: string | null;
  nextBillingDate: string;
  user: { name: string; email: string };
  plan: { name: string; category: string };
}

const statusColors = {
  ACTIVE: "bg-green-900/40 text-green-400 border-green-800",
  SUSPENDED: "bg-amber-900/40 text-amber-400 border-amber-800",
  CANCELLED: "bg-red-900/40 text-red-400 border-red-800",
  DELETED: "bg-gray-800/60 text-gray-400 border-gray-700",
};

export default function AdminServersPage() {
  const [services, setServices] = useState<ServiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ServiceRecord | null>(null);
  const [editForm, setEditForm] = useState({
    serverIp: "",
    sshUsername: "",
    sshPassword: "",
    panelUrl: "",
    status: "ACTIVE",
  });
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    fetch("/api/admin/services")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setServices(d.data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function startEdit(svc: ServiceRecord) {
    setEditing(svc);
    setEditForm({
      serverIp: svc.serverIp || "",
      sshUsername: svc.sshUsername || "",
      sshPassword: svc.sshPassword || "",
      panelUrl: svc.panelUrl || "",
      status: svc.status,
    });
  }

  function saveEdit(serviceId: string) {
    startTransition(async () => {
      const res = await fetch(`/api/admin/services/${serviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });
      const data = await res.json();
      if (res.ok) {
        setServices((s) => s.map((svc) => (svc.id === serviceId ? data.data : svc)));
        setEditing(null);
        showToast("Service updated!", "success");
      } else {
        showToast(data.error || "Update failed", "error");
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
        <h1 className="text-2xl font-bold text-white">Server Management</h1>
        <p className="text-gray-500 text-sm mt-1">
          Manage server credentials and service status for all clients
        </p>
      </div>

      {editing && (
        <div className="bg-[#111827] border border-purple-700/50 rounded-xl p-6 mb-6">
          <h2 className="text-white font-semibold mb-4">
            Edit Service — {editing.user.name} / {editing.plan.name}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Server IP"
              placeholder="192.168.1.1"
              value={editForm.serverIp}
              onChange={(e) => setEditForm((f) => ({ ...f, serverIp: e.target.value }))}
            />
            <Input
              label="SSH Username"
              placeholder="root"
              value={editForm.sshUsername}
              onChange={(e) => setEditForm((f) => ({ ...f, sshUsername: e.target.value }))}
            />
            <Input
              label="SSH Password"
              type="password"
              placeholder="SSH password"
              value={editForm.sshPassword}
              onChange={(e) => setEditForm((f) => ({ ...f, sshPassword: e.target.value }))}
            />
            <Input
              label="Panel URL (Coolify)"
              placeholder="https://panel.example.com"
              value={editForm.panelUrl}
              onChange={(e) => setEditForm((f) => ({ ...f, panelUrl: e.target.value }))}
            />
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-gray-300">Status</label>
              <select
                value={editForm.status}
                onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}
                className="w-full px-4 py-2.5 rounded-lg bg-[#0A0F1E] border border-[#374151] text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-600"
              >
                <option value="ACTIVE">Active</option>
                <option value="SUSPENDED">Suspended</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </div>
          </div>
          <div className="flex gap-3 mt-5">
            <Button loading={isPending} onClick={() => saveEdit(editing.id)}>Save Changes</Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </div>
      )}

      <div className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#1F2937]">
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Client</th>
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Plan</th>
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Server IP</th>
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Status</th>
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Next Billing</th>
                <th className="text-right px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1F2937]">
              {services.map((svc) => (
                <tr key={svc.id} className="hover:bg-white/[0.02] transition-colors">
                  <td className="px-6 py-4">
                    <p className="text-white text-sm font-medium">{svc.user.name}</p>
                    <p className="text-gray-500 text-xs">{svc.user.email}</p>
                  </td>
                  <td className="px-6 py-4">
                    <p className="text-gray-300 text-sm">{svc.plan.name}</p>
                    <p className="text-gray-500 text-xs">{svc.plan.category}</p>
                  </td>
                  <td className="px-6 py-4">
                    <code className="text-white text-sm font-mono">{svc.serverIp || "—"}</code>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-md border ${statusColors[svc.status]}`}>
                      {svc.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-400 text-sm">
                    {new Date(svc.nextBillingDate).toLocaleDateString("en-IN")}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Button variant="secondary" size="sm" onClick={() => startEdit(svc)}>
                      Edit
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
