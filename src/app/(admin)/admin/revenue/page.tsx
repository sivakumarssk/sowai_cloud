import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

async function getRevenueData() {
  const payments = await prisma.payment.findMany({
    where: { status: "SUCCESS" },
    include: { service: { include: { plan: true } }, user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
  });

  const planRevenue: Record<string, number> = {};
  const monthlyRevenue: Record<string, number> = {};

  for (const p of payments) {
    const planName = p.service?.plan?.name || "Unknown";
    planRevenue[planName] = (planRevenue[planName] || 0) + p.amount + p.gstAmount;

    const month = new Date(p.createdAt).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
    monthlyRevenue[month] = (monthlyRevenue[month] || 0) + p.amount + p.gstAmount;
  }

  return { payments, planRevenue, monthlyRevenue };
}

export default async function AdminRevenuePage() {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") redirect("/dashboard");

  const { payments, planRevenue, monthlyRevenue } = await getRevenueData();
  const totalRevenue = payments.reduce((sum, p) => sum + p.amount + p.gstAmount, 0);
  const totalGst = payments.reduce((sum, p) => sum + p.gstAmount, 0);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Revenue</h1>
        <p className="text-gray-500 text-sm mt-1">Financial overview and payment history</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <p className="text-gray-500 text-xs mb-1 uppercase tracking-wider">Total Revenue</p>
          <p className="text-3xl font-black text-green-400">₹{totalRevenue.toLocaleString("en-IN")}</p>
        </div>
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <p className="text-gray-500 text-xs mb-1 uppercase tracking-wider">Total GST Collected</p>
          <p className="text-3xl font-black text-white">₹{totalGst.toLocaleString("en-IN")}</p>
        </div>
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <p className="text-gray-500 text-xs mb-1 uppercase tracking-wider">Total Transactions</p>
          <p className="text-3xl font-black text-white">{payments.length}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Revenue by plan */}
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6">
          <h2 className="text-white font-semibold mb-4">Revenue by Plan</h2>
          <div className="flex flex-col gap-3">
            {Object.entries(planRevenue)
              .sort((a, b) => b[1] - a[1])
              .map(([plan, amount]) => {
                const pct = Math.round((amount / totalRevenue) * 100) || 0;
                return (
                  <div key={plan}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-300">{plan}</span>
                      <span className="text-white font-semibold">₹{amount.toLocaleString("en-IN")}</span>
                    </div>
                    <div className="h-2 bg-[#1F2937] rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-purple-600 to-purple-400 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
          </div>
        </div>

        {/* Monthly revenue */}
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6">
          <h2 className="text-white font-semibold mb-4">Monthly Revenue</h2>
          <div className="flex flex-col gap-3">
            {Object.entries(monthlyRevenue).map(([month, amount]) => (
              <div key={month} className="flex justify-between items-center">
                <span className="text-gray-400 text-sm">{month}</span>
                <span className="text-white text-sm font-semibold">₹{amount.toLocaleString("en-IN")}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Payment history */}
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-[#1F2937]">
          <h2 className="text-white font-semibold">All Payments</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#1F2937]">
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Invoice</th>
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Client</th>
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Plan</th>
                <th className="text-left px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Date</th>
                <th className="text-right px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">Amount</th>
                <th className="text-right px-6 py-3 text-gray-500 text-xs font-medium uppercase tracking-wider">GST</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1F2937]">
              {payments.map((p) => (
                <tr key={p.id} className="hover:bg-white/[0.02] transition-colors">
                  <td className="px-6 py-4 text-white text-sm font-mono">#{p.invoiceNumber}</td>
                  <td className="px-6 py-4">
                    <p className="text-gray-300 text-sm">{p.user.name}</p>
                    <p className="text-gray-500 text-xs">{p.user.email}</p>
                  </td>
                  <td className="px-6 py-4 text-gray-300 text-sm">{p.service?.plan?.name || "—"}</td>
                  <td className="px-6 py-4 text-gray-400 text-sm">
                    {new Date(p.createdAt).toLocaleDateString("en-IN")}
                  </td>
                  <td className="px-6 py-4 text-white text-sm font-semibold text-right">
                    ₹{p.amount.toLocaleString("en-IN")}
                  </td>
                  <td className="px-6 py-4 text-gray-400 text-sm text-right">
                    ₹{p.gstAmount.toLocaleString("en-IN")}
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
