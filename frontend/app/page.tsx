import Dashboard from "@/components/Dashboard";
import RequireVerified from "@/components/RequireVerified";

export default function Home() {
  return (
    <RequireVerified>
      <Dashboard />
    </RequireVerified>
  );
}