import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session || session.role !== "ADMIN") return apiError("Forbidden", 403);

  const { id } = await params;
  const { message } = await req.json();
  if (!message) return apiError("Message is required");

  const ticket = await prisma.ticket.findUnique({ where: { id } });
  if (!ticket) return apiError("Ticket not found", 404);

  const messages = [
    ...(ticket.messages as { role: string; message: string; createdAt: string }[]),
    { role: "ADMIN", message, createdAt: new Date().toISOString() },
  ];

  const updated = await prisma.ticket.update({
    where: { id },
    data: { messages, status: "IN_PROGRESS" },
    include: { user: { select: { name: true, email: true } } },
  });

  return apiSuccess(updated);
}
