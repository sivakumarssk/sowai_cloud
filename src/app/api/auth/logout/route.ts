import { clearAuthCookie } from "@/lib/auth";
import { apiSuccess } from "@/lib/types";

export async function POST() {
  await clearAuthCookie();
  return apiSuccess({ message: "Logged out successfully" });
}
