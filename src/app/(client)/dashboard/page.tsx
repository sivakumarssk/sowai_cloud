import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import type { ServiceStatus } from "@prisma/client";

async function getDashboardData(userId: string) {
  const [services, payments, notifications] = await Promise.all([
    prisma.service.findMany({
      where: { userId },
      include: { plan: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.payment.findMany({
      where: { userId, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.notification.findMany({
      where: { userId, isRead: false },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);
  return { services, payments, notifications };
}

const statusColors: Record<ServiceStatus, string> = {
  PENDING: "bg-blue-900/40 text-blue-400 border-blue-800",
  PROVISIONING: "bg-blue-900/40 text-blue-400 border-blue-800",
  ACTIVE: "bg-green-900/40 text-green-400 border-green-800",
  SUSPENDED: "bg-amber-900/40 text-amber-400 border-amber-800",
  CANCELLED: "bg-red-900/40 text-red-400 border-red-800",
  FAILED: "bg-red-900/40 text-red-400 border-red-800",
};

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const { services, payments, notifications } = await getDashboardData(session.userId);

  const activeServices = services.filter((s) => s.status === "ACTIVE");
  const nextBilling = activeServices.reduce<Date | null>((earliest, s) => {
    if (!earliest || s.nextBillingDate < earliest) return s.nextBillingDate;
    return earliest;
  }, null);

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">
          Welcome back, {session.name.split(" ")[0]}
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Here&apos;s an overview of your Sowsi Cloud account
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[
          {
            label: "Active Services",
            value: activeServices.length,
            icon: (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
              </svg>
            ),
            color: "text-blue-400",
          },
          {
            label: "Next Billing",
            value: nextBilling
              ? new Date(nextBilling).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
              : "—",
            icon: (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            ),
            color: "text-amber-400",
          },
          {
            label: "Total Invoices",
            value: payments.length,
            icon: (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            ),
            color: "text-green-400",
          },
          {
            label: "Notifications",
            value: notifications.length,
            icon: (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            ),
            color: "text-purple-400",
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-[#111827] border border-[#1F2937] rounded-xl p-5 flex items-center gap-4"
          >
            <div className={`${stat.color} shrink-0`}>{stat.icon}</div>
            <div>
              <p className="text-2xl font-bold text-white">{stat.value}</p>
              <p className="text-gray-500 text-xs">{stat.label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Services */}
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-white font-semibold">My Services</h2>
            <Link href="/dashboard/services" className="text-[#1B4FE8] text-sm hover:text-[#0EA5E9] transition-colors">
              View all
            </Link>
          </div>

          {services.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-gray-500 text-sm mb-3">No services yet</p>
              <Link href="/pricing">
                <button className="bg-[#1B4FE8] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#1540C4] transition-colors">
                  Browse Plans
                </button>
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {services.map((service) => (
                <div
                  key={service.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-[#0A0F1E] border border-[#1F2937]"
                >
                  <div className="min-w-0">
                    <p className="text-white text-sm font-medium truncate">{service.plan.name}</p>
                    <p className="text-gray-500 text-xs">
                      Renews {new Date(service.nextBillingDate).toLocaleDateString("en-IN")}
                    </p>
                  </div>
                  <span
                    className={`text-xs font-medium px-2 py-1 rounded-md border shrink-0 ml-2 ${statusColors[service.status]}`}
                  >
                    {service.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Invoices */}
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-white font-semibold">Recent Invoices</h2>
            <Link href="/dashboard/billing" className="text-[#1B4FE8] text-sm hover:text-[#0EA5E9] transition-colors">
              View all
            </Link>
          </div>

          {payments.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-8">No invoices yet</p>
          ) : (
            <div className="flex flex-col gap-3">
              {payments.map((payment) => (
                <div
                  key={payment.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-[#0A0F1E] border border-[#1F2937]"
                >
                  <div className="min-w-0">
                    <p className="text-white text-sm font-medium">#{payment.invoiceNumber}</p>
                    <p className="text-gray-500 text-xs">
                      {new Date(payment.createdAt).toLocaleDateString("en-IN")}
                    </p>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    <p className="text-white text-sm font-semibold">
                      ₹{(payment.amount + payment.gstAmount).toLocaleString("en-IN")}
                    </p>
                    <span className="text-green-400 text-xs">Paid</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Notifications */}
        {notifications.length > 0 && (
          <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6 lg:col-span-2">
            <h2 className="text-white font-semibold mb-4">Notifications</h2>
            <div className="flex flex-col gap-2">
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className="flex items-start gap-3 p-3 rounded-lg bg-[#1B4FE8]/5 border border-[#1B4FE8]/20"
                >
                  <div className="w-2 h-2 rounded-full bg-[#1B4FE8] mt-1.5 shrink-0" />
                  <div>
                    <p className="text-white text-sm font-medium">{n.title}</p>
                    <p className="text-gray-400 text-xs mt-0.5">{n.message}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quick actions */}
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6 lg:col-span-2">
          <h2 className="text-white font-semibold mb-4">Quick Actions</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { href: "/pricing", label: "Add Service", icon: "➕" },
              { href: "/dashboard/support", label: "Open Ticket", icon: "🎫" },
              { href: "/dashboard/billing", label: "View Invoices", icon: "🧾" },
              { href: "/dashboard/profile", label: "Edit Profile", icon: "⚙️" },
            ].map((action) => (
              <Link
                key={action.href}
                href={action.href}
                className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl bg-[#0A0F1E] border border-[#1F2937] hover:border-[#1B4FE8]/50 hover:bg-[#1B4FE8]/5 transition-all text-center"
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
