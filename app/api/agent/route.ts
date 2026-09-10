import { z } from "zod";
import {
  actorFrom,
  sameOrigin,
  jsonBody,
  errorResponse,
  AppError,
} from "@/lib/server/auth";
import {
  listRuns,
  runBudget,
  startRun,
  executeRun,
  cancelRun,
  agentConfigured,
} from "@/lib/server/agent";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const actor = actorFrom(req),
      id = new URL(req.url).searchParams.get("deckId");
    if (!id) throw new AppError(400, "Не указана презентация.");
    return Response.json(
      {
        runs: await listRuns(actor, id),
        budget: await runBudget(actor),
        configured: agentConfigured(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(req: Request) {
  try {
    const actor = actorFrom(req);
    sameOrigin(req);
    const b = await jsonBody(req, 30_000),
      { action, ...input } = b;
    if (action === "start")
      return Response.json(
        { run: await startRun(actor, input) },
        { status: 202 },
      );
    const { runId } = z
      .object({ runId: z.string().uuid() })
      .strict()
      .parse(input);
    if (action === "execute")
      return Response.json({ run: await executeRun(actor, runId) });
    if (action === "cancel")
      return Response.json({ run: await cancelRun(actor, runId) });
    throw new AppError(400, "Неизвестное действие.");
  } catch (e) {
    return errorResponse(e);
  }
}
