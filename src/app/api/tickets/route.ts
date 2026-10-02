import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiSuccess, apiError } from "@/lib/types";

export async function GET() {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const tickets = await prisma.ticket.findMany({
    where: { userId: session.userId },
    orderBy: { updatedAt: "desc" },
  });

  return apiSuccess(tickets);
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { subject, message, priority } = await req.json();
  if (!subject || !message) return apiError("Subject and message are required");

  const ticket = await prisma.ticket.create({
    data: {
      userId: session.userId,
      subject,
      priority: priority || "MEDIUM",
      messages: [{ role: "CLIENT", message, createdAt: new Date().toISOString() }],
    },
  });

  return apiSuccess(ticket);
}
