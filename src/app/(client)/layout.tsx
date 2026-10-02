import DashboardNav from "@/components/dashboard/DashboardNav";
import { ToastContainer } from "@/components/ui/Toast";

export default function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-[#0A0F1E]">
      <DashboardNav />
      <div className="flex-1 flex flex-col min-w-0">
        <main className="flex-1 p-6 lg:p-8">{children}</main>
      </div>
      <ToastContainer />
    </div>
  );
}
