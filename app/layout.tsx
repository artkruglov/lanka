import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lanka Studio — презентации команды",
  description:
    "Создание, редактирование и согласование корпоративных презентаций.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased">{children}</body>
    </html>
  );
}
