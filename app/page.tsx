import { requireChatGPTUser } from "./chatgpt-auth";
import Studio from "@/components/studio";
export const dynamic = "force-dynamic";
export default async function Home() {
  const user = await requireChatGPTUser("/");
  return <Studio user={{ name: user.displayName, email: user.email }} />;
}
