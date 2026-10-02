import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { id } = await params;
  const { message } = await req.json();
  if (!message) return apiError("Message is required");

  const ticket = await prisma.ticket.findFirst({
    where: { id, userId: session.userId },
  });
  if (!ticket) return apiError("Ticket not found", 404);

  const messages = [
    ...(ticket.messages as { role: string; message: string; createdAt: string }[]),
    { role: "CLIENT", message, createdAt: new Date().toISOString() },
  ];

  const updated = await prisma.ticket.update({
    where: { id },
    data: { messages, status: "IN_PROGRESS" },
  });

  return apiSuccess(updated);
}
