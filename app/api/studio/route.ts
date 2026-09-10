import {
  actorFrom,
  sameOrigin,
  jsonBody,
  errorResponse,
} from "@/lib/server/auth";
import {
  listDecks,
  getDeck,
  getBrands,
  activity,
  history,
  getReleases,
  saveBrand,
} from "@/lib/server/store";
import { command } from "@/lib/server/commands";
import { agentConfigured, runAgent } from "@/lib/server/agent";
import { deckLinks } from "@/lib/deck-links";
import { openStarter } from "@/lib/server/starters";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const actor = actorFrom(req),
      url = new URL(req.url),
      id = url.searchParams.get("deckId");
    if (id)
      return Response.json(
        {
          deck: await getDeck(actor, id),
          links: deckLinks(url.origin,id),
          activity: await activity(actor, id),
          history: await history(actor, id),
          releases: await getReleases(actor, id),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    return Response.json(
      {
        decks: await listDecks(actor),
        brands: await getBrands(actor),
        agentConfigured: agentConfigured(),
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
    const b = await jsonBody(req);
    if(b.action==="open_starter"){
      const deck=await openStarter(actor,b.slug);
      return Response.json({deck,links:deckLinks(new URL(req.url).origin,deck.id)});
    }
    if (b.action === "saveBrand")
      return Response.json({ brand: await saveBrand(actor, b.brand) });
    if (b.action === "agent")
      return Response.json({ deck: await runAgent(actor, b) });
    const deck=await command(actor,b);
    return Response.json({deck,links:deckLinks(new URL(req.url).origin,deck.id)});
  } catch (e) {
    return errorResponse(e);
  }
}
