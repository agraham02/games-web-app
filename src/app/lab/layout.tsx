import { LabNav } from "@/lab/LabShell";

export default function LabLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-svh flex-col bg-felt-950">
      <LabNav />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">{children}</div>
    </div>
  );
}
