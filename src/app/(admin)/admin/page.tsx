import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";

async function getAdminStats() {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalClients,
    activeServices,
    openTickets,
    monthlyRevenue,
    recentSignups,
    monthlyPayments,
  ] = await Promise.all([
    prisma.user.count({ where: { role: "CLIENT" } }),
    prisma.service.count({ where: { status: "ACTIVE" } }),
    prisma.ticket.count({ where: { status: { in: ["OPEN", "IN_PROGRESS"] } } }),
    prisma.payment.aggregate({
      where: { status: "SUCCESS", createdAt: { gte: firstOfMonth } },
      _sum: { amount: true, gstAmount: true },
    }),
    prisma.user.findMany({
      where: { role: "CLIENT" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, name: true, email: true, createdAt: true },
    }),
    // Last 6 months revenue
    prisma.payment.groupBy({
      by: ["createdAt"],
      where: { status: "SUCCESS" },
      _sum: { amount: true, gstAmount: true },
    }),
  ]);

  return {
    totalClients,
    activeServices,
    openTickets,
    monthlyRevenue:
      (monthlyRevenue._sum.amount || 0) + (monthlyRevenue._sum.gstAmount || 0),
    recentSignups,
  };
}

export default async function AdminPage() {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") redirect("/dashboard");

  const stats = await getAdminStats();

  const statCards = [
    {
      label: "Monthly Revenue",
      value: `₹${stats.monthlyRevenue.toLocaleString("en-IN")}`,
      color: "text-green-400",
      icon: "💰",
    },
    {
      label: "Total Clients",
      value: stats.totalClients,
      color: "text-blue-400",
      icon: "👥",
    },
    {
      label: "Active Services",
      value: stats.activeServices,
      color: "text-purple-400",
      icon: "🖥️",
    },
    {
      label: "Open Tickets",
      value: stats.openTickets,
      color: stats.openTickets > 0 ? "text-amber-400" : "text-green-400",
      icon: "🎫",
    },
  ];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Admin Overview</h1>
        <p className="text-gray-500 text-sm mt-1">
          Welcome back, {session.name}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {statCards.map((s) => (
          <div
            key={s.label}
            className="bg-[#111827] border border-[#1F2937] rounded-xl p-5"
          >
            <div className="flex items-center justify-between mb-3">
              <p className="text-gray-500 text-xs font-medium uppercase tracking-wider">{s.label}</p>
              <span className="text-2xl">{s.icon}</span>
            </div>
            <p className={`text-3xl font-black ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent signups */}
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-white font-semibold">Recent Signups</h2>
            <Link href="/admin/clients" className="text-purple-400 text-sm hover:text-purple-300 transition-colors">
              View all
            </Link>
          </div>
          <div className="flex flex-col gap-3">
            {stats.recentSignups.map((client) => (
              <div key={client.id} className="flex items-center gap-3 p-3 rounded-lg bg-[#0A0F1E] border border-[#1F2937]">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#1B4FE8] to-[#0EA5E9] flex items-center justify-center text-white text-xs font-bold shrink-0">
                  {client.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-white text-sm font-medium truncate">{client.name}</p>
                  <p className="text-gray-500 text-xs truncate">{client.email}</p>
                </div>
                <p className="text-gray-600 text-xs shrink-0">
                  {new Date(client.createdAt).toLocaleDateString("en-IN")}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Quick links */}
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6">
          <h2 className="text-white font-semibold mb-5">Admin Actions</h2>
          <div className="grid grid-cols-2 gap-3">
            {[
              { href: "/admin/clients", label: "Manage Clients", icon: "👥" },
              { href: "/admin/servers", label: "Manage Servers", icon: "🖥️" },
              { href: "/admin/tickets", label: "Open Tickets", icon: "🎫" },
              { href: "/admin/revenue", label: "Revenue Report", icon: "📊" },
            ].map((action) => (
              <Link
                key={action.href}
                href={action.href}
                className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl bg-[#0A0F1E] border border-[#1F2937] hover:border-purple-700/50 hover:bg-purple-900/10 transition-all text-center"
              >
                <span className="text-2xl">{action.icon}</span>
                <span className="text-gray-400 text-xs font-medium">{action.label}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
