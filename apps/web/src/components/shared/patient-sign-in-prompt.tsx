import { LogIn } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Inline replacement for patient pages whose session-dependent request was
 * rejected. It reuses the existing passwordless patient session flow and
 * returns the patient to the page they were on after signing in.
 */
export function PatientSignInPrompt({
  title = "Sign in to see your visits",
  description = "Your session has expired or isn't active. Sign in with the same mobile number to continue.",
}: {
  title?: string;
  description?: string;
}) {
  const location = useLocation();

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <LogIn className="size-5" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <p className="font-medium">{title}</p>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        <Button asChild>
          <Link to="/start" state={{ from: { pathname: location.pathname } }}>
            Sign in with mobile number
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
