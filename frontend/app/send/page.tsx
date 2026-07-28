import Dashboard from "@/components/Dashboard";
import RequireVerified from "@/components/RequireVerified";

export default function SendPage() {
  return (
    <RequireVerified>
      <Dashboard />
    </RequireVerified>
  );
}