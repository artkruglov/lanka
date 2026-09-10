import Studio from "@/components/studio";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { deckPath } from "@/lib/deck-links";
export const dynamic = "force-dynamic";
export default async function PresentationPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{mode?:string}>}) {
  const {id}=await params, {mode}=await searchParams;
  return <Presentation id={id} present={mode==="present"}/>;
}
async function Presentation({id,present}:{id:string;present:boolean}) {
  const user=await requireChatGPTUser(deckPath(id,present?"present":"edit"));
  return <Studio user={{name:user.displayName,email:user.email}} initialDeckId={id} initialPresent={present}/>;
}
