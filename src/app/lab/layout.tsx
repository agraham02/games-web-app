import { notFound } from "next/navigation";
import { labEnabled } from "@/lab/enabled";
import { LabNav } from "@/lab/LabShell";

export default function LabLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Dev only: see `labEnabled`.
  if (!labEnabled()) notFound();
  return (
    <div className="flex h-svh flex-col bg-felt-950">
      <LabNav />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">{children}</div>
    </div>
  );
}
