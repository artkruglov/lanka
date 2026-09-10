import Studio from "@/components/studio";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
export const dynamic = "force-dynamic";
export default async function SalesFocusV3Example() {
  const user = await requireChatGPTUser("/examples/lanka-sales-focus-v3");
  return <Studio user={{name: user.displayName, email: user.email}} starterSlug="lanka-sales-focus-v3" />;
}
